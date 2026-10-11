import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { WALLPAPER_MIME_TYPES } from "@otuken/shared";
import {
  EmptyDesktopQuerySchema,
  WallpaperParamsSchema,
  WallpaperUploadHeadersSchema,
} from "@otuken/shared/schemas";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import { ApiError, notFound } from "../../http/errors.ts";
import { parseParams, parseQuery } from "../../http/validation.ts";
import { requirePermission, requireAuth } from "../../middleware/auth.ts";
import type { ImagePurpose } from "./wallpaper-service.ts";
import type { Services } from "../../services.ts";

export function wallpaperRoutes(
  services: Services,
  purpose: ImagePurpose = "wallpaper",
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const resource = purpose === "folder-icon" ? "folder-icons" : "wallpapers";
  app.use("*", requirePermission("preferences:manage"));

  app.get("/", (c) => {
    parseQuery(c, EmptyDesktopQuerySchema);
    const images = services.wallpapers.list(requireAuth(c).user.id, purpose);
    return c.json(purpose === "folder-icon" ? { icons: images } : { wallpapers: images });
  });

  /** Raw image upload (the request body is the file). */
  app.post("/", async (c) => {
    parseQuery(c, EmptyDesktopQuerySchema);
    const auth = requireAuth(c);
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!(WALLPAPER_MIME_TYPES as readonly string[]).includes(type)) {
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload a JPEG, PNG or WebP image");
    }
    const body = c.req.raw.body;
    if (!body) throw new ApiError(400, "WALLPAPER_INVALID", "Empty upload");
    const lengthHeader = c.req.header("content-length");
    const headers = WallpaperUploadHeadersSchema.safeParse(
      lengthHeader === undefined ? {} : { contentLength: lengthHeader },
    );
    if (!headers.success) throw new ApiError(400, "VALIDATION_FAILED", "Invalid upload length");
    const declared = headers.data.contentLength ?? null;
    const info = await services.wallpapers.store(
      auth.user.id,
      declared,
      body as WebReadableStream<Uint8Array>,
      purpose,
    );
    services.audit.record({
      action: `${resource}.upload`,
      outcome: "success",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      target: info.id,
      details: { mime: info.mime, size: info.size, width: info.width, height: info.height },
    });
    return c.json(info, 201);
  });

  app.get("/:id/image", (c) => {
    parseQuery(c, EmptyDesktopQuerySchema);
    const auth = requireAuth(c);
    const { id } = parseParams(c, WallpaperParamsSchema);
    const file = services.wallpapers.file(auth.user.id, id, purpose);
    if (!file) throw notFound("Wallpaper");
    const body = Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Content-Type": file.mime,
        "Content-Length": String(file.size),
        // Ids are never reused, so the image is immutable; keep it out of shared caches.
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Disposition": "inline",
      },
    });
  });

  app.delete("/:id", async (c) => {
    parseQuery(c, EmptyDesktopQuerySchema);
    const auth = requireAuth(c);
    const { id } = parseParams(c, WallpaperParamsSchema);
    if (purpose === "folder-icon") {
      const appearance = services.preferences.getAll(auth.user.id).appearance;
      const references = [
        appearance?.folderIcon,
        ...(appearance?.folderIcons ?? []).map((item) => item.icon),
      ];
      if (references.some((icon) => icon?.kind === "uploaded" && icon.iconId === id))
        throw new ApiError(409, "CONFLICT", "Folder icon is in use");
    }
    if (!(await services.wallpapers.delete(auth.user.id, id, purpose))) throw notFound("Wallpaper");
    services.audit.record({
      action: `${resource}.delete`,
      outcome: "success",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      target: id,
    });
    return c.body(null, 204);
  });

  return app;
}
