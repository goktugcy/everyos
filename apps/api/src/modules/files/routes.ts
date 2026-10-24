import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { isShelfTemporary, type FileRootsResponse, type ShelfTidyResponse } from "@everyos/shared";
import {
  DeleteRequestSchema,
  FileSettingsSchema,
  FileDownloadQuerySchema,
  FileListQuerySchema,
  FileLocationQuerySchema,
  FileSearchQuerySchema,
  FileUploadQuerySchema,
  MkdirRequestSchema,
  RenameRequestSchema,
  ShelfDiscardRequestSchema,
  TextWriteRequestSchema,
  TransferRequestSchema,
  TrashItemRequestSchema,
  TrashDeleteRequestSchema,
} from "@everyos/shared/schemas";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../../context.ts";
import { agentActor } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { parseJsonBody, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import { fileViewFor } from "./file-view.ts";
import { readFileSettings, writeFileSettings } from "./file-settings.ts";

/** Raster formats that are safe to show in place; everything else downloads. */
const INLINE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};

/** RFC 6266 attachment header with an ASCII fallback and the UTF-8 name. */
function disposition(kind: "attachment" | "inline", name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start > end || start >= size) return "invalid";
  return { start, end };
}

/** The file manager API (docs/files.md); mutations are audited. */
export function fileRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Each request sees the caller's own view: their home, the configured
  // locations and, for administrators who enabled them, system paths.
  const files = (c: Context<AppEnv>) => {
    const auth = requireAuth(c);
    return fileViewFor(
      services,
      {
        user: auth.user,
        permissions: auth.permissions,
        actor: agentActor(auth, c.get("client").ip),
      },
      { signal: c.req.raw.signal, logger: c.get("logger") },
    );
  };
  const enabled: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!services.files.enabled && services.config.mode !== "production")
      throw new ApiError(404, "FILES_DISABLED", "No file locations are configured on this server");
    await services.files.withAccess(requireAuth(c).user.id, next);
  };
  app.use("*", requirePermission("files:read"), enabled);
  const write = requirePermission("files:write");

  const audit = (
    c: Context<AppEnv>,
    action: string,
    target: string,
    details?: Record<string, unknown>,
  ) => {
    const auth = requireAuth(c);
    services.audit.record({
      action: `files.${action}`,
      outcome: details?.succeeded === false ? "failure" : "success",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      target: target.slice(0, 512),
      ...(details ? { details } : {}),
    });
  };

  app.get("/roots", async (c) => {
    const auth = requireAuth(c);
    const body: FileRootsResponse = {
      roots: await files(c).roots(auth.permissions.has("files:write")),
      system: {
        enabled: readFileSettings(services.db).systemRoots,
        canManage: auth.permissions.has("system:manage"),
      },
    };
    return c.json(body);
  });

  /** Administrators turn the read-only system locations on or off (audited). */
  app.put("/settings", requirePermission("system:manage"), async (c) => {
    const settings = await parseJsonBody(c, FileSettingsSchema);
    writeFileSettings(services.db, settings, services.now());
    audit(c, "settings", "system-roots", { systemRoots: settings.systemRoots });
    return c.json(settings);
  });

  app.get("/list", async (c) => {
    const { root, path, hidden } = parseQuery(c, FileListQuerySchema);
    return c.json(await files(c).list(root, path, hidden === "true"));
  });

  app.get("/properties", async (c) => {
    const { root, path } = parseQuery(c, FileLocationQuerySchema);
    return c.json(await files(c).properties(root, path));
  });

  app.get("/search", async (c) => {
    const { root, path, q } = parseQuery(c, FileSearchQuerySchema);
    return c.json(await files(c).search(root, path, q));
  });

  app.get("/text", async (c) => {
    const { root, path } = parseQuery(c, FileLocationQuerySchema);
    return c.json(await files(c).readText(root, path));
  });

  app.get("/download", async (c) => {
    const { root, path, inline, discard } = parseQuery(c, FileDownloadQuerySchema);
    const view = files(c);
    const file = await view.openFile(root, path);
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const inlineType = inline ? INLINE_TYPES[extension] : undefined;
    const range = parseRange(c.req.header("range"), file.size);
    if (range === "invalid") {
      await file.handle.close();
      return c.body(null, 416, { "Content-Range": `bytes */${file.size}` });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? file.size - 1;
    const stream =
      file.size === 0
        ? Readable.from([])
        : file.handle.createReadStream({ start, end, autoClose: true });
    if (file.size === 0) await file.handle.close();
    // Dragged off the shelf onto the computer: the shelf's file goes once the browser has all of it.
    // (The session cookie is SameSite=Strict, so another site cannot trigger this.)
    const auth = requireAuth(c);
    if (
      discard === "true" &&
      !range &&
      isShelfTemporary({ root, path }) &&
      auth.permissions.has("files:write")
    ) {
      const logger = c.get("logger");
      stream.once("end", () => {
        void services.files
          .withAccess(auth.user.id, () => view.discardShelf([path]))
          .then(() =>
            audit(c, "shelf.discard", `${root}:${path}`, { count: 1, reason: "download" }),
          )
          .catch((error: unknown) =>
            logger.warn("Could not delete a shelf file after its download", { error }),
          );
      });
    }
    const headers: Record<string, string> = {
      "Content-Type": inlineType ?? "application/octet-stream",
      "Content-Disposition": disposition(inlineType ? "inline" : "attachment", file.name),
      "Content-Length": String(file.size === 0 ? 0 : end - start + 1),
      "Accept-Ranges": "bytes",
      "Last-Modified": new Date(file.modifiedAt).toUTCString(),
      "Cache-Control": "private, no-store",
      // Even if a browser rendered the file, it could not run anything.
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${file.size}`;
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: range ? 206 : 200,
      headers,
    });
  });

  app.put("/text", write, async (c) => {
    const { root, path, content, etag } = await parseJsonBody(c, TextWriteRequestSchema);
    const saved = await files(c).writeText(root, path, content, etag);
    audit(c, etag === null ? "create" : "write", `${root}:${path}`, { size: saved.size });
    return c.json(saved);
  });

  /** Raw upload: the body is the file; `Content-Length` is required. */
  app.post("/upload", write, async (c) => {
    const { root, path, name, overwrite } = parseQuery(c, FileUploadQuerySchema);
    const length = Number(c.req.header("content-length"));
    if (!c.req.header("content-length") || !Number.isSafeInteger(length) || length < 0)
      throw new ApiError(411, "VALIDATION_FAILED", "Content-Length is required");
    const body = c.req.raw.body ?? new ReadableStream<Uint8Array>({ start: (ctl) => ctl.close() });
    await files(c).upload(
      root,
      path,
      name,
      body as WebReadableStream<Uint8Array>,
      length,
      overwrite === "true",
    );
    audit(c, "upload", `${root}:${[path, name].filter(Boolean).join("/")}`, { size: length });
    return c.body(null, 201);
  });

  app.post("/mkdir", write, async (c) => {
    const { root, path, name } = await parseJsonBody(c, MkdirRequestSchema);
    await files(c).mkdir(root, path, name);
    audit(c, "mkdir", `${root}:${[path, name].filter(Boolean).join("/")}`);
    return c.body(null, 201);
  });

  app.post("/rename", write, async (c) => {
    const { root, path, name } = await parseJsonBody(c, RenameRequestSchema);
    await files(c).rename(root, path, name);
    audit(c, "rename", `${root}:${path}`, { name });
    return c.body(null, 204);
  });

  app.post("/copy", write, async (c) => {
    const { root, paths, destination, name } = await parseJsonBody(c, TransferRequestSchema);
    await files(c).copy(root, paths, destination, name);
    audit(c, "copy", `${root}:${paths.join(", ")}`, {
      destination: `${destination.root}:${destination.path}`,
      count: paths.length,
    });
    return c.body(null, 204);
  });

  app.post("/move", write, async (c) => {
    const { root, paths, destination, name } = await parseJsonBody(c, TransferRequestSchema);
    if (name !== undefined)
      throw new ApiError(400, "VALIDATION_FAILED", "Use rename to change a name");
    await files(c).move(root, paths, destination);
    audit(c, "move", `${root}:${paths.join(", ")}`, {
      destination: `${destination.root}:${destination.path}`,
      count: paths.length,
    });
    return c.body(null, 204);
  });

  app.post("/delete", write, async (c) => {
    const { root, paths } = await parseJsonBody(c, DeleteRequestSchema);
    let succeeded = false;
    try {
      await files(c).remove(root, paths);
      succeeded = true;
    } finally {
      audit(c, "delete", `${root}:${paths.join(", ")}`, {
        count: paths.length,
        mode: "trash",
        succeeded,
      });
    }
    return c.body(null, 204);
  });

  /** Files the shelf holds itself (docs/pulse.md): removed from the shelf, deleted for good. */
  app.post("/shelf/discard", write, async (c) => {
    const { paths } = await parseJsonBody(c, ShelfDiscardRequestSchema);
    await files(c).discardShelf(paths);
    audit(c, "shelf.discard", `home:${paths.join(", ")}`, { count: paths.length });
    return c.body(null, 204);
  });

  /** Deletes shelf files the stored shelf has not listed for an hour; returns the ones left. */
  app.post("/shelf/tidy", write, async (c) => {
    const auth = requireAuth(c);
    const listed = new Set(
      (services.preferences.getAll(auth.user.id).pulse?.shelf ?? [])
        .filter(isShelfTemporary)
        .map((item) => item.path),
    );
    const { paths, removed } = await files(c).tidyShelf(listed, services.now());
    if (removed) audit(c, "shelf.tidy", "home", { count: removed });
    const body: ShelfTidyResponse = { paths };
    return c.json(body);
  });

  app.get("/trash", async (c) => c.json(await files(c).trash()));

  app.post("/trash/restore", write, async (c) => {
    const { root, ids } = await parseJsonBody(c, TrashItemRequestSchema);
    let succeeded = false;
    try {
      await files(c).restoreTrash(root, ids);
      succeeded = true;
    } finally {
      audit(c, "trash.restore", root, { ids, count: ids.length, succeeded });
    }
    return c.body(null, 204);
  });

  app.post("/trash/delete", write, async (c) => {
    const { root, ids } = await parseJsonBody(c, TrashDeleteRequestSchema);
    let succeeded = false;
    try {
      await files(c).deleteTrash(root, ids);
      succeeded = true;
    } finally {
      audit(c, "trash.delete", root, { ids, count: ids.length, succeeded });
    }
    return c.body(null, 204);
  });

  return app;
}
