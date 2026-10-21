import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { WALLPAPER_MIME_TYPES } from "@everyos/shared";
import { WallpaperParamsSchema, WallpaperUploadHeadersSchema } from "@everyos/shared/schemas";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { ApiError, notFound } from "../../http/errors.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import { instanceCall, requireCapability, type InstanceCall } from "./sdk-routes.ts";

const Empty = z.strictObject({});
const KindParam = z.strictObject({ kind: z.enum(["wallpaper", "folder-icon"]) });
const ImageParam = KindParam.extend(WallpaperParamsSchema.shape);

/**
 * `/api/app-sdk/appearance`: the person's uploaded wallpapers and folder icons, for apps holding
 * appearance:manage (checked here, every call). Choosing a wallpaper or folder icon is the
 * person's own preference, which the desktop applies after checking the same grant.
 */
export function appSdkAppearanceRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requirePermission("apps:read"));
  const { wallpapers } = services;
  const withAppearance = (c: Context<AppEnv>): InstanceCall => {
    const call = instanceCall(services, c);
    requireCapability(call, "appearance:manage");
    return call;
  };
  const audit = (
    c: Context<AppEnv>,
    call: InstanceCall,
    action: string,
    details: Record<string, unknown>,
  ) =>
    services.audit.record({
      action: `desktop-apps.appearance.${action}`,
      target: call.instance.appId,
      outcome: "success",
      actor: { userId: call.auth.user.id, username: call.auth.user.username },
      ip: c.get("client").ip,
      details,
    });

  app.get("/images", (c) => {
    parseQuery(c, Empty);
    const call = withAppearance(c);
    return c.json({
      wallpapers: wallpapers.list(call.auth.user.id, "wallpaper"),
      folderIcons: wallpapers.list(call.auth.user.id, "folder-icon"),
    });
  });

  app.get("/images/:kind/:id", (c) => {
    parseQuery(c, Empty);
    const { kind, id } = parseParams(c, ImageParam);
    const call = withAppearance(c);
    const file = wallpapers.file(call.auth.user.id, id, kind);
    if (!file) throw notFound("Image");
    return new Response(Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": file.mime,
        "Content-Length": String(file.size),
        "Cache-Control": "private, no-store",
      },
    });
  });

  /** A raw JPEG, PNG or WebP body, checked and bounded like the person's own uploads. */
  app.post("/images/:kind", async (c) => {
    parseQuery(c, Empty);
    const { kind } = parseParams(c, KindParam);
    const call = withAppearance(c);
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!(WALLPAPER_MIME_TYPES as readonly string[]).includes(type))
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload a JPEG, PNG or WebP image");
    const body = c.req.raw.body;
    if (!body) throw new ApiError(400, "WALLPAPER_INVALID", "Empty upload");
    const length = c.req.header("content-length");
    const headers = WallpaperUploadHeadersSchema.safeParse(
      length === undefined ? {} : { contentLength: length },
    );
    if (!headers.success) throw new ApiError(400, "VALIDATION_FAILED", "Invalid upload length");
    const info = await wallpapers.store(
      call.auth.user.id,
      headers.data.contentLength ?? null,
      body as WebReadableStream<Uint8Array>,
      kind,
    );
    audit(c, call, "upload", { kind, image: info.id, size: info.size });
    return c.json(info, 201);
  });

  app.delete("/images/:kind/:id", async (c) => {
    parseQuery(c, Empty);
    const { kind, id } = parseParams(c, ImageParam);
    await parseJsonBody(c, Empty);
    const call = withAppearance(c);
    if (kind === "folder-icon") {
      const appearance = services.preferences.getAll(call.auth.user.id).appearance;
      const used = [
        appearance?.folderIcon,
        ...(appearance?.folderIcons ?? []).map((item) => item.icon),
      ];
      if (used.some((icon) => icon?.kind === "uploaded" && icon.iconId === id))
        throw new ApiError(409, "CONFLICT", "Folder icon is in use");
    }
    if (!(await wallpapers.delete(call.auth.user.id, id, kind))) throw notFound("Image");
    audit(c, call, "delete", { kind, image: id });
    return c.body(null, 204);
  });

  return app;
}
