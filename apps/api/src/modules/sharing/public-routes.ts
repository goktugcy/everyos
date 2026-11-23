import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  QuickAccessSchema,
  QuickUploadSchema,
  SharingIdParamsSchema,
} from "@everyos/shared/schemas";
import type { AppEnv } from "../../context.ts";
import type { Services } from "../../services.ts";
import { ApiError } from "../../http/errors.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { csrfProtection } from "../../middleware/csrf.ts";
import { normalizeAddress, isLoopbackAddress } from "../../http/client-info.ts";
import { parseRange } from "../files/routes.ts";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

const bearer = (c: Context<AppEnv>) =>
  /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
const cookieName = (id: string) => "everyos-quick-" + id.replaceAll("-", "");
export function isQuickSharePrivateAddress(address: string) {
  const ip = normalizeAddress(address).toLowerCase();
  if (isLoopbackAddress(ip)) return true;
  if (ip.includes(":")) return /^(?:fc|fd|fe[89ab])/.test(ip);
  const parts = ip.split(".").map(Number);
  return (
    parts.length === 4 &&
    parts.every((v) => Number.isInteger(v) && v >= 0 && v < 256) &&
    (parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
      (parts[0] === 169 && parts[1] === 254))
  );
}
/** Capability-only routes deliberately do not load, unlock or use an EveryOS session. */
export function publicQuickShareRoutes(services: Services) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const client = c.get("client");
    if (!isQuickSharePrivateAddress(client.ip))
      throw new ApiError(403, "SHARING_NETWORK_DENIED", "Quick Share requires a private network");
    if (!client.secure && !client.loopback)
      throw new ApiError(400, "SHARING_HTTPS_REQUIRED", "Quick Share requires HTTPS");
    services.quickShares.rate(client.ip);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
    if (c.res.status >= 400)
      services.audit.record({
        actor: null,
        action: "sharing.quick.request",
        outcome: "failure",
        target: "quick-share",
        ip: client.ip,
      });
  });
  app.use("*", csrfProtection(services));
  const grant = (c: Context<AppEnv>, id: string) => getCookie(c, cookieName(id)) ?? bearer(c);
  app.post("/access", async (c) => {
    const { password } = await parseJsonBody(c, QuickAccessSchema);
    const result = await services.quickShares.access(bearer(c), password, c.get("client").ip);
    setCookie(c, cookieName(result.id), result.grant, {
      httpOnly: true,
      secure: c.get("client").secure,
      sameSite: "Strict",
      path: "/api/quick-share/" + result.id,
      maxAge: Math.max(1, Math.floor((result.expiresAt - services.now()) / 1000)),
    });
    return c.json(result);
  });
  app.get("/:id", async (c) => {
    const { id } = parseParams(c, SharingIdParamsSchema);
    parseQuery(c, z.strictObject({}));
    return c.json(await services.quickShares.metadata(id, grant(c, id)));
  });
  app.get("/:id/download/:index", async (c) => {
    const { id, index } = parseParams(
      c,
      z.strictObject({
        id: SharingIdParamsSchema.shape.id,
        index: z.coerce.number().int().min(0).max(99),
      }),
    );
    parseQuery(c, z.strictObject({}));
    const token = grant(c, id);
    const metadata = await services.quickShares.metadata(id, token);
    const item = metadata.entries.find((e) => e.index === index);
    if (!item) throw new ApiError(404, "NOT_FOUND", "File not found");
    const range = parseRange(c.req.header("range"), item.size);
    if (range === "invalid") return c.body(null, 416, { "Content-Range": "bytes */" + item.size });
    const file = await services.quickShares.download(
      id,
      token,
      index,
      c.req.raw.signal,
      range ?? undefined,
    );
    const fallback = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    c.header("Content-Type", "application/octet-stream");
    c.header(
      "Content-Disposition",
      'attachment; filename="' + fallback + "\"; filename*=UTF-8''" + encodeURIComponent(file.name),
    );
    c.header("Content-Length", String(file.length));
    c.header("Accept-Ranges", "bytes");
    if (range)
      c.header("Content-Range", "bytes " + range.start + "-" + range.end + "/" + file.size);
    return c.body(
      Readable.toWeb(file.stream) as unknown as globalThis.ReadableStream,
      range ? 206 : 200,
    );
  });
  app.post("/:id/upload", async (c) => {
    const { id } = parseParams(c, SharingIdParamsSchema);
    const { name } = parseQuery(c, QuickUploadSchema);
    const token = grant(c, id);
    if (c.req.header("x-everyos-quick-grant") !== token)
      throw new ApiError(403, "CSRF_FAILED", "Quick Share grant header required");
    const length = Number(c.req.header("content-length"));
    if (!c.req.header("content-length") || !Number.isSafeInteger(length) || length < 0)
      throw new ApiError(411, "VALIDATION_FAILED", "Content-Length required");
    const body =
      c.req.raw.body ??
      new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    const result = await services.quickShares.upload(
      id,
      token,
      name,
      body as WebReadableStream<Uint8Array>,
      length,
      c.req.raw.signal,
    );
    return c.json(result, 201);
  });
  return app;
}
