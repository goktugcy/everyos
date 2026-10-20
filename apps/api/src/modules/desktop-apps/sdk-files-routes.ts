import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  AppFileChildSchema,
  AppFileGrantSchema,
  AppFileHandleParamSchema,
  AppFileListQuerySchema,
  AppFileReadQuerySchema,
  AppFileSaveSchema,
  AppFileWriteQuerySchema,
} from "@everyos/shared/schemas";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { agentActor } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import { fileViewFor, type FileUser } from "../files/file-view.ts";
import { parseRange } from "../files/routes.ts";
import { mimeOf, type FileGrantRow } from "./app-files.ts";
import { instanceCall, requireCapability, type InstanceCall } from "./sdk-routes.ts";

const Empty = z.strictObject({});
const MAX_CHUNK = 512 * 1024;

function requireAny(call: InstanceCall, capabilities: string[]): void {
  let lastError: unknown = null;
  for (const capability of capabilities) {
    try {
      requireCapability(call, capability);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** `/api/app-sdk/files`: items the person picked for the app, and nothing else. */
export function appSdkFileRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const files = services.desktopApps.files;
  app.use("*", requirePermission("apps:read"));

  const who = (c: Context<AppEnv>): FileUser => {
    const auth = requireAuth(c);
    return {
      user: auth.user,
      permissions: auth.permissions,
      actor: agentActor(auth, c.get("client").ip),
    };
  };
  const viewOf = (c: Context<AppEnv>) =>
    fileViewFor(services, who(c), { signal: c.req.raw.signal, logger: c.get("logger") });
  const grantOf = (c: Context<AppEnv>, call: InstanceCall): FileGrantRow => {
    const { id } = parseParams(c, AppFileHandleParamSchema);
    return files.find(id, call.instance.appId, call.auth.user.id, call.instance.id);
  };
  const handle = async (c: Context<AppEnv>, grant: FileGrantRow) => {
    const resolved = await files
      .resolve(viewOf(c), grant, "", "any")
      .catch(() => ({ size: null as number | null }));
    return files.view(grant, resolved.size);
  };

  app.post("/grants", async (c) => {
    parseQuery(c, Empty);
    const input = await parseJsonBody(c, AppFileGrantSchema);
    const call = instanceCall(services, c);
    requireCapability(call, input.write ? "files:save" : "files:pick");
    const view = viewOf(c);
    const handles = [];
    for (const item of input.items) {
      const properties = await view.properties(item.root, item.path);
      if (properties.type !== "file" && properties.type !== "directory")
        throw new ApiError(400, "VALIDATION_FAILED", "Only files and folders can be shared");
      const grant = files.grant({
        appId: call.instance.appId,
        userId: call.auth.user.id,
        instance: call.instance.id,
        root: item.root,
        path: properties.path,
        kind: properties.type,
        writable: input.write,
        persistent: input.persist,
      });
      handles.push(files.view(grant, properties.size));
    }
    return c.json({ handles }, 201);
  });

  app.post("/grants/save", async (c) => {
    parseQuery(c, Empty);
    const input = await parseJsonBody(c, AppFileSaveSchema);
    const call = instanceCall(services, c);
    requireCapability(call, "files:save");
    const view = viewOf(c);
    const folder = await view.properties(input.root, input.path);
    if (folder.type !== "directory") throw new ApiError(400, "VALIDATION_FAILED", "Not a folder");
    const path = [folder.path, input.name].filter(Boolean).join("/");
    try {
      // An empty file holds the name; the app's first write fills it.
      await view.upload(
        input.root,
        folder.path,
        input.name,
        Readable.toWeb(Readable.from([])) as WebReadableStream<Uint8Array>,
        0,
        false,
      );
    } catch (error) {
      // The person chose to replace an existing file in the save dialog.
      if (!(error instanceof ApiError && error.code === "CONFLICT")) throw error;
    }
    const properties = await view.properties(input.root, path);
    if (properties.type !== "file") throw new ApiError(409, "CONFLICT", "A folder has this name");
    const grant = files.grant({
      appId: call.instance.appId,
      userId: call.auth.user.id,
      instance: call.instance.id,
      root: input.root,
      path,
      kind: "file",
      writable: true,
      persistent: input.persist,
    });
    return c.json({ handle: files.view(grant, properties.size) }, 201);
  });

  app.get("/", (c) => {
    parseQuery(c, Empty);
    const call = instanceCall(services, c);
    requireAny(call, ["files:pick", "files:save"]);
    return c.json({
      handles: files
        .list(call.instance.appId, call.auth.user.id, call.instance.id)
        .map((grant) => files.view(grant, null)),
    });
  });

  app.get("/:id", async (c) => {
    parseQuery(c, Empty);
    const call = instanceCall(services, c);
    requireAny(call, ["files:pick", "files:save"]);
    return c.json({ handle: await handle(c, grantOf(c, call)) });
  });

  app.get("/:id/read", async (c) => {
    const { offset, length } = parseQuery(c, AppFileReadQuerySchema);
    const call = instanceCall(services, c);
    requireAny(call, ["files:pick", "files:save"]);
    const grant = grantOf(c, call);
    const view = viewOf(c);
    const { path, size } = await files.resolve(view, grant, "", "file");
    if (offset >= size)
      return c.body(new Uint8Array(0), 200, {
        "Content-Type": "application/octet-stream",
        "X-EveryOS-EOF": "1",
      });
    const file = await view.openFile(grant.root, path);
    const end = Math.min(file.size, offset + length) - 1;
    const chunks: Buffer[] = [];
    for await (const chunk of file.handle.createReadStream({ start: offset, end, autoClose: true }))
      chunks.push(Buffer.from(chunk as Uint8Array));
    await file.handle.close().catch(() => undefined);
    const body = Buffer.concat(chunks);
    return c.body(new Uint8Array(body), 200, {
      "Content-Type": "application/octet-stream",
      "X-EveryOS-EOF": offset + body.length >= file.size ? "1" : "0",
    });
  });

  app.post("/:id/write", async (c) => {
    const { offset, done } = parseQuery(c, AppFileWriteQuerySchema);
    const call = instanceCall(services, c);
    requireCapability(call, "files:save");
    const grant = grantOf(c, call);
    const view = viewOf(c);
    await files.resolve(view, grant, "", "file");
    // At most one chunk is read, whatever Content-Length claims.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of Readable.fromWeb(
      (c.req.raw.body ??
        new ReadableStream<Uint8Array>({
          start: (ctl) => ctl.close(),
        })) as WebReadableStream<Uint8Array>,
    )) {
      size += (chunk as Uint8Array).length;
      if (size > MAX_CHUNK)
        throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Chunks are at most 512 KiB");
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const result = await files.write({
      view,
      grant,
      instance: call.instance.id,
      offset,
      data: Buffer.concat(chunks),
      done: done === "true",
      maxBytes: services.config.files.maxUploadBytes,
    });
    return c.json(result);
  });

  app.get("/:id/list", async (c) => {
    const { path } = parseQuery(c, AppFileListQuerySchema);
    const call = instanceCall(services, c);
    requireAny(call, ["files:pick", "files:save"]);
    const grant = grantOf(c, call);
    const view = viewOf(c);
    const folder = await files.resolve(view, grant, path, "directory");
    const listing = await view.list(grant.root, folder.path, false);
    return c.json({
      entries: listing.entries
        .filter((entry) => entry.type === "file" || entry.type === "directory")
        .map((entry) => ({
          name: entry.name,
          kind: entry.type,
          size: entry.type === "file" ? entry.size : null,
          modifiedAt: entry.modifiedAt,
        })),
    });
  });

  app.post("/:id/child", async (c) => {
    parseQuery(c, Empty);
    const input = await parseJsonBody(c, AppFileChildSchema);
    const call = instanceCall(services, c);
    requireAny(call, ["files:pick", "files:save"]);
    const parent = grantOf(c, call);
    if (parent.kind !== "directory") throw new ApiError(400, "VALIDATION_FAILED", "Not a folder");
    const view = viewOf(c);
    const parts = input.path.split("/").filter(Boolean);
    if (input.create) {
      if (parent.mode !== "readwrite") throw new ApiError(403, "FORBIDDEN", "Read-only folder");
      requireCapability(call, "files:save");
      const folder = await files.resolve(view, parent, parts.slice(0, -1).join("/"), "directory");
      const name = parts.at(-1)!;
      try {
        if (input.create === "directory") await view.mkdir(parent.root, folder.path, name);
        else
          await view.upload(
            parent.root,
            folder.path,
            name,
            Readable.toWeb(Readable.from([])) as WebReadableStream<Uint8Array>,
            0,
            false,
          );
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "CONFLICT")) throw error;
      }
    }
    const child = await files.resolve(view, parent, input.path, "any");
    const grant = files.grant({
      appId: call.instance.appId,
      userId: call.auth.user.id,
      instance: call.instance.id,
      root: parent.root,
      path: child.path,
      kind: child.kind,
      writable: parent.mode === "readwrite",
      persistent: parent.persistent === 1,
    });
    return c.json({ handle: files.view(grant, child.size) }, 201);
  });

  app.post("/:id/url", async (c) => {
    parseQuery(c, Empty);
    await parseJsonBody(c, Empty);
    const call = instanceCall(services, c);
    requireAny(call, ["files:pick", "files:save"]);
    const grant = grantOf(c, call);
    const { path } = await files.resolve(viewOf(c), grant, "", "file");
    return c.json(
      files.issueUrl({
        grant: grant.id,
        appId: call.instance.appId,
        user: who(c),
        root: grant.root,
        path,
      }),
    );
  });

  app.delete("/:id", async (c) => {
    parseQuery(c, Empty);
    await parseJsonBody(c, Empty);
    const call = instanceCall(services, c);
    const grant = grantOf(c, call);
    files.revoke(grant.id, call.instance.appId, call.auth.user.id);
    return c.body(null, 204);
  });

  return app;
}

/**
 * `/app-files/<token>`: one granted file for media elements (`<audio>`, `<video>`, `<img>`) in an
 * app's opaque frame, without cookies, read-only and short-lived.
 */
export function appMediaRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const notFound = () =>
    new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  app.on(["GET", "HEAD"], "/:token", async (c) => {
    const url = services.desktopApps.files.mediaUrl(c.req.param("token"));
    if (
      !url ||
      !services.desktopApps.files.exists(url.grant) ||
      !services.desktopApps.installer.active(url.appId)
    )
      return notFound();
    const view = fileViewFor(services, url.user, { logger: c.get("logger") });
    const file = await view.openFile(url.root, url.path).catch(() => null);
    if (!file) return notFound();
    const range = parseRange(c.req.header("range"), file.size);
    if (range === "invalid") {
      await file.handle.close();
      return c.body(null, 416, { "Content-Range": `bytes */${file.size}` });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? file.size - 1;
    const headers: Record<string, string> = {
      "Content-Type": mimeOf(url.path) ?? "application/octet-stream",
      "Content-Length": String(file.size === 0 ? 0 : end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Access-Control-Allow-Origin": "*",
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${file.size}`;
    if (c.req.method === "HEAD" || file.size === 0) {
      await file.handle.close();
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    const stream = file.handle.createReadStream({ start, end, autoClose: true });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: range ? 206 : 200,
      headers,
    });
  });
  app.all("*", () => notFound());
  return app;
}
