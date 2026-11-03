import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "../apps/web/node_modules/vite/dist/node/index.js";
import { expect, it, vi } from "vitest";

it("proxies scoped MP4 byte ranges and HEAD requests instead of returning the desktop HTML", async () => {
  const bytes = await readFile(new URL("../tests/e2e/fixtures/media/demo.mp4", import.meta.url));
  const requests: Array<{ method: string; host: string | undefined; range: string | undefined }> =
    [];
  const api = createHttpServer((request, response) => {
    if (request.url !== "/app-files/test-media") {
      response.writeHead(404);
      response.end();
      return;
    }
    requests.push({
      method: request.method ?? "GET",
      host: request.headers.host,
      range: request.headers.range,
    });
    const ranged = request.headers.range === "bytes=0-31";
    const data = ranged ? bytes.subarray(0, 32) : bytes;
    response.writeHead(ranged ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": data.length,
      "Accept-Ranges": "bytes",
      ...(ranged ? { "Content-Range": `bytes 0-31/${bytes.length}` } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : data);
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const apiAddress = api.address();
  if (!apiAddress || typeof apiAddress === "string") throw new Error("No API address");
  vi.stubEnv("EVERYOS_API_URL", `http://127.0.0.1:${apiAddress.port}`);
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  try {
    vite = await createViteServer({
      root: fileURLToPath(new URL("../apps/web/", import.meta.url)),
      configFile: fileURLToPath(new URL("../apps/web/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No frontend address");
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}/app-files/test-media`, {
      headers: { Range: "bytes=0-31" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe(`bytes 0-31/${bytes.length}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(0, 32));
    const head = await fetch(`${origin}/app-files/test-media`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    expect(await head.text()).toBe("");
    expect(requests).toEqual([
      { method: "GET", host: `127.0.0.1:${address.port}`, range: "bytes=0-31" },
      { method: "HEAD", host: `127.0.0.1:${address.port}`, range: undefined },
    ]);
  } finally {
    vi.unstubAllEnvs();
    await vite?.close();
    await new Promise<void>((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 30_000);
