import { createReadStream, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

const COMPRESSIBLE = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".svg",
  ".webmanifest",
  ".txt",
]);

interface ResolvedFile {
  path: string;
  size: number;
}

async function fileAt(path: string): Promise<ResolvedFile | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { path, size: info.size } : null;
  } catch {
    return null;
  }
}

/**
 * Serves the built web client. Paths are normalized and confined to the web
 * root; unknown non-asset paths fall back to index.html for client-side
 * navigation. Hashed assets are cached immutably, the HTML shell is not.
 * Pre-compressed .br/.gz siblings (produced at build time) are preferred so
 * the Raspberry Pi does not spend CPU compressing on every request.
 */
export function serveWebClient(webDir: string): MiddlewareHandler<AppEnv> {
  const root = realpathSync(webDir);
  const indexPath = join(root, "index.html");

  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    if (c.req.path.startsWith("/api/") || c.req.path === "/api") return next();

    // Decode the raw pathname exactly once (c.req.path is already partially decoded).
    let decoded: string;
    try {
      decoded = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text("Bad Request", 400);
    }
    if (decoded.includes("\0")) return c.text("Bad Request", 400);

    const candidate = normalize(join(root, decoded));
    const insideRoot = candidate === root || candidate.startsWith(root + sep);
    let file = insideRoot ? await fileAt(candidate) : null;
    const isAsset = decoded.startsWith("/assets/");
    if (!file) {
      // Missing hashed assets must 404 instead of returning HTML.
      if (isAsset || extname(decoded) !== "") return c.text("Not Found", 404);
      file = await fileAt(indexPath);
      if (!file) return c.text("Web client is not built", 503);
    }

    const extension = extname(file.path);
    const headers = new Headers({
      "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "Cache-Control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
    });

    let servedPath = file.path;
    let size = file.size;
    if (COMPRESSIBLE.has(extension)) {
      headers.set("Vary", "Accept-Encoding");
      const accept = c.req.header("accept-encoding") ?? "";
      for (const [encoding, suffix] of [
        ["br", ".br"],
        ["gzip", ".gz"],
      ] as const) {
        if (!accept.includes(encoding)) continue;
        const compressed = await fileAt(file.path + suffix);
        if (compressed) {
          servedPath = compressed.path;
          size = compressed.size;
          headers.set("Content-Encoding", encoding);
          break;
        }
      }
    }
    headers.set("Content-Length", String(size));
    if (c.req.method === "HEAD") return new Response(null, { status: 200, headers });
    const body = Readable.toWeb(createReadStream(servedPath)) as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers });
  };
}
