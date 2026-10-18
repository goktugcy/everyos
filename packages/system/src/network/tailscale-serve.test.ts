import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setTailscaleServe, TailscaleServeError } from "./tailscale-client.ts";

/* A tailscaled LocalAPI on a Unix socket that keeps one ServeConfig, with ETags like the real one. */
async function fakeLocalApi(options: {
  serve?: Record<string, unknown>;
  certDomains?: string[];
  backendState?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "everyos-ts-"));
  const socket = join(dir, "tailscaled.sock");
  const state = { serve: options.serve ?? {}, version: 1, writes: 0 };
  const server: Server = createServer((request, response) => {
    if (request.headers.host !== "local-tailscaled.sock") {
      response.writeHead(403);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url?.startsWith("/localapi/v0/status")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            BackendState: options.backendState ?? "Running",
            Self: { DNSName: "pi.tail1234.ts.net." },
            CertDomains: options.certDomains ?? ["pi.tail1234.ts.net"],
          }),
        );
        return;
      }
      if (request.url === "/localapi/v0/serve-config" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "application/json",
          Etag: `"v${state.version}"`,
        });
        response.end(JSON.stringify(state.serve));
        return;
      }
      if (request.url === "/localapi/v0/serve-config" && request.method === "POST") {
        if (request.headers["if-match"] !== `"v${state.version}"`) {
          response.writeHead(412);
          response.end();
          return;
        }
        state.serve = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        state.version++;
        state.writes++;
        response.writeHead(200);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  servers.push(server);
  dirs.push(dir);
  return { sockets: [socket], state };
}

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof TailscaleServeError ? error.reason : String(error)),
  );

describe("EveryOS's Tailscale Serve handler", () => {
  it("adds only its own HTTPS handler, keeps others, and removes only its own", async () => {
    const other = { Handlers: { "/grafana": { Proxy: "http://127.0.0.1:3000" } } };
    const api = await fakeLocalApi({
      serve: {
        TCP: { "443": { HTTPS: true }, "22": { TCPForward: "127.0.0.1:22" } },
        Web: { "pi.tail1234.ts.net:443": other },
      },
    });
    expect(await setTailscaleServe({ enabled: true, port: 7470 }, api.sockets)).toEqual({
      url: "https://pi.tail1234.ts.net",
    });
    expect(api.state.serve).toEqual({
      TCP: { "443": { HTTPS: true }, "22": { TCPForward: "127.0.0.1:22" } },
      Web: {
        "pi.tail1234.ts.net:443": {
          Handlers: {
            "/grafana": { Proxy: "http://127.0.0.1:3000" },
            "/": { Proxy: "http://127.0.0.1:7470" },
          },
        },
      },
    });
    // Turning it on again changes nothing.
    await setTailscaleServe({ enabled: true, port: 7470 }, api.sockets);
    expect(api.state.writes).toBe(1);
    expect(await setTailscaleServe({ enabled: false, port: 7470 }, api.sockets)).toEqual({
      url: null,
    });
    expect(api.state.serve).toEqual({
      TCP: { "443": { HTTPS: true }, "22": { TCPForward: "127.0.0.1:22" } },
      Web: { "pi.tail1234.ts.net:443": other },
    });
  });

  it("cleans up completely when its handler was the only one", async () => {
    const api = await fakeLocalApi({});
    await setTailscaleServe({ enabled: true, port: 7470 }, api.sockets);
    expect(api.state.serve).toEqual({
      TCP: { "443": { HTTPS: true } },
      Web: { "pi.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7470" } } } },
    });
    await setTailscaleServe({ enabled: false, port: 7470 }, api.sockets);
    expect(api.state.serve).toEqual({});
  });

  it("refuses a taken port, Funnel, missing HTTPS certificates and a stopped Tailscale", async () => {
    const taken = await fakeLocalApi({
      serve: {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "pi.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } },
        },
      },
    });
    expect(await reason(setTailscaleServe({ enabled: true, port: 7470 }, taken.sockets))).toBe(
      "port-in-use",
    );
    // Someone else's handler on "/" is never removed either.
    await setTailscaleServe({ enabled: false, port: 7470 }, taken.sockets);
    expect(taken.state.writes).toBe(0);
    const forwarded = await fakeLocalApi({ serve: { TCP: { "443": { TCPForward: "x:443" } } } });
    expect(await reason(setTailscaleServe({ enabled: true, port: 7470 }, forwarded.sockets))).toBe(
      "port-in-use",
    );
    const funnel = await fakeLocalApi({
      serve: { AllowFunnel: { "pi.tail1234.ts.net:443": true } },
    });
    expect(await reason(setTailscaleServe({ enabled: true, port: 7470 }, funnel.sockets))).toBe(
      "funnel",
    );
    const noCerts = await fakeLocalApi({ certDomains: [] });
    expect(await reason(setTailscaleServe({ enabled: true, port: 7470 }, noCerts.sockets))).toBe(
      "https-disabled",
    );
    const stopped = await fakeLocalApi({ backendState: "NeedsLogin" });
    expect(await reason(setTailscaleServe({ enabled: true, port: 7470 }, stopped.sockets))).toBe(
      "not-running",
    );
    expect(
      await reason(setTailscaleServe({ enabled: true, port: 7470 }, ["/nonexistent/ts.sock"])),
    ).toBe("not-detected");
  });
});
