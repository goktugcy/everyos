import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { isPackagePath } from "@everyos/app-manifest";
import { contentTypeOf } from "@everyos/app-package";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import type { DesktopAppInstaller } from "./installer.ts";

/**
 * What an app document may do. `sandbox` keeps it in an opaque origin even when opened on its own;
 * nothing remote can be loaded, and only the desktop may frame it.
 */
export const RUNTIME_CSP = [
  "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

const notFound = () =>
  new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

/**
 * `/app-runtime/<key>/<path>`: an installed version's static files. The key is a random
 * per-version capability, so no session is needed (an opaque frame's requests carry no usable
 * cookies) and a new version never reuses cached files of an old one.
 */
export function appRuntimeRoutes(installer: DesktopAppInstaller): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.on(["GET", "HEAD"], "/:key/*", async (c) => {
    const key = c.req.param("key");
    const located = installer.runtimeDirectory(key);
    if (!located) return notFound();
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname.slice(`/app-runtime/${key}/`.length));
    } catch {
      return notFound();
    }
    const type = isPackagePath(path) ? contentTypeOf(path) : null;
    if (!type) return notFound();
    const file = join(located.dir, ...path.split("/"));
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile()) return notFound();
    const headers = {
      "Content-Type": type,
      "Content-Length": String(info.size),
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Security-Policy": RUNTIME_CSP,
      "X-Frame-Options": "SAMEORIGIN",
      "Cross-Origin-Resource-Policy": "cross-origin",
      // Module scripts from an opaque origin are CORS requests.
      "Access-Control-Allow-Origin": "*",
    };
    if (c.req.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      status: 200,
      headers,
    });
  });
  app.all("*", () => notFound());
  return app;
}
