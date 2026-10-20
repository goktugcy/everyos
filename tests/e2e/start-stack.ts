/**
 * Starts the *built* agent and API (dist/) for end-to-end tests, with all
 * state in a throwaway directory. Run `pnpm build` before `pnpm test:e2e`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ServerResponse } from "node:http";
import { startAppRegistry } from "./app-registry-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
// Keep it short: Unix socket paths inside it are limited to about 100 bytes.
export const E2E_STATE_DIR = process.env.EVERYOS_E2E_STATE_DIR ?? join(here, ".state");
export const E2E_PORT = Number(process.env.EVERYOS_E2E_PORT ?? 7480);

if (!existsSync(join(root, "dist/api/server.mjs"))) {
  console.error("dist/ is missing. Run `pnpm build` first.");
  process.exit(1);
}

rmSync(E2E_STATE_DIR, { recursive: true, force: true });
mkdirSync(E2E_STATE_DIR, { recursive: true });
const apiConfig = join(E2E_STATE_DIR, "api.yaml");
// These disposable fixtures need a reserve, but not the production 1 GiB allowance.
// The official desktop app registry is a local fixture with throwaway keys (a LAN "mirror").
const appRegistry = await startAppRegistry(E2E_PORT + 2);
writeFileSync(
  apiConfig,
  "files:\n  minFreeMiB: 64\nbackups:\n  minFreeMiB: 64\n" +
    `desktopApps:\n  officialRegistry:\n    url: ${appRegistry.url}\n    publicKey: ${JSON.stringify(appRegistry.publicKey)}\n    allowPrivate: true\n`,
);

const env = {
  ...process.env,
  EVERYOS_ENV: "development",
  EVERYOS_DEV_ROOT: E2E_STATE_DIR,
  EVERYOS_WEB_DIR: join(root, "dist/web"),
  EVERYOS_PORT: String(E2E_PORT),
  EVERYOS_LOG_LEVEL: "warn",
  // Deterministic systemd/journald data on every OS (CI runners have real systemd).
  EVERYOS_AGENT_SIMULATE: "1",
  // A real PTY, running only as the unprivileged test runner's account.
  EVERYOS_DEV_TERMINAL: "1",
  // The stand-in tailscaled below (the real LocalAPI client and parsers run against it).
  EVERYOS_TAILSCALE_SOCKET: join(E2E_STATE_DIR, "tailscaled.sock"),
  // An in-memory Google OAuth and Drive for the Drive browser tests.
  EVERYOS_DEV_FAKE_GOOGLE: "1",
};

/**
 * Minimal stand-in for tailscaled's LocalAPI on a Unix socket (test fixture
 * only; invented names and documentation addresses). EveryOS is published with
 * Serve but its origin is not configured, so the app shows that warning.
 */
const day = 24 * 60 * 60_000;
const tailscaled = createServer((request, response) => {
  const routes: Record<string, unknown> = {
    "/localapi/v0/status?peers=true": tailscaleStatus(true),
    "/localapi/v0/status?peers=false": tailscaleStatus(false),
    "/localapi/v0/prefs": { RunSSH: false, ShieldsUp: false, RouteAll: false, CorpDNS: true },
    "/localapi/v0/serve-config": {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "everyos-e2e.example-tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: `http://127.0.0.1:${E2E_PORT}` } },
        },
      },
    },
  };
  const body = request.headers.host === "local-tailscaled.sock" ? routes[request.url ?? ""] : null;
  response.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body ?? {}));
});
tailscaled.listen(env.EVERYOS_TAILSCALE_SOCKET);

function tailscaleStatus(peers: boolean) {
  return {
    Version: "1.104.0",
    BackendState: "Running",
    TailscaleIPs: ["100.100.100.10"],
    Self: {
      HostName: "everyos-e2e",
      DNSName: "everyos-e2e.example-tailnet.ts.net.",
      OS: "linux",
      Online: true,
      Relay: "fra",
      KeyExpiry: new Date(Date.now() + 60 * day).toISOString(),
    },
    CurrentTailnet: {
      Name: "example-tailnet",
      MagicDNSSuffix: "example-tailnet.ts.net",
      MagicDNSEnabled: true,
    },
    Health: [],
    Peer: peers
      ? {
          a: {
            HostName: "laptop",
            OS: "macOS",
            TailscaleIPs: ["100.100.100.11"],
            Online: true,
            Active: true,
            CurAddr: "192.0.2.30:41641",
            RxBytes: 2048,
            TxBytes: 4096,
          },
          b: {
            HostName: "phone",
            OS: "iOS",
            TailscaleIPs: ["100.100.100.12"],
            Online: true,
            Active: true,
            Relay: "ams",
          },
        }
      : {},
  };
}

const children: ChildProcess[] = [
  spawn(process.execPath, [join(root, "dist/agent/agent.mjs")], { env, stdio: "inherit" }),
  spawn(process.execPath, [join(root, "dist/api/server.mjs")], {
    env: { ...env, EVERYOS_CONFIG: apiConfig },
    stdio: "inherit",
  }),
];

// Original catalog fixture served over HTTP to exercise the real safe fetcher.
// Installed containers still use the explicitly labeled Docker simulator.
const catalog = createServer((request, response) => {
  if (request.url?.startsWith("/jellyfin/")) {
    fakeJellyfin(request.url.slice("/jellyfin".length), request.headers.authorization, response);
    return;
  }
  if (request.url !== "/catalog.yml") {
    response.writeHead(404);
    response.end();
    return;
  }
  response.setHeader("Content-Type", "text/yaml");
  response.end(
    "services:\n  demo:\n    image: example.invalid/original-e2e:1.0\n    ports: ['8765:80']\n    volumes: ['${APP_DATA_DIR}/data:/data:ro']\n    environment:\n      PUID: ${PUID}\n      PGID: ${PGID}\n      TZ: ${TZ}\n      APP_TOKEN: ${APP_TOKEN}\n      PASSWORD: ${SERVICE_PASSWORD_64_DEMO}\nx-casaos:\n  id: original-e2e\n  title: {tr_TR: Deneme Uygulaması, en_US: Test Application}\n  description: {tr_TR: İzole uçtan uca test kataloğu., en_US: Isolated end-to-end test catalog.}\n  architectures: [amd64, arm64]\n",
  );
});
catalog.listen(E2E_PORT + 1, "127.0.0.1");

/**
 * Minimal stand-in for a Jellyfin server (test fixture only, never real
 * media data) so widget integrations run through the real API client.
 */
function fakeJellyfin(
  path: string,
  authorization: string | undefined,
  response: ServerResponse,
): void {
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (path === "/System/Info/Public")
    return json(200, { ServerName: "E2E Jellyfin", Version: "10.10.7" });
  if (!authorization?.includes('Token="e2e-jellyfin-key"'))
    return json(401, { error: "unauthorized" });
  if (path.startsWith("/Sessions"))
    return json(200, [
      {
        UserName: "ayse",
        Client: "Jellyfin Web",
        DeviceName: "Salon TV",
        RemoteEndPoint: "192.168.1.44",
        NowPlayingItem: { Name: "Deneme Filmi", Type: "Movie", RunTimeTicks: 1000 },
        PlayState: { PositionTicks: 400, IsPaused: false },
      },
      { UserName: "mehmet", Client: "Android", DeviceName: "Telefon" },
    ]);
  if (path === "/Items/Counts")
    return json(200, {
      MovieCount: 12,
      SeriesCount: 3,
      EpisodeCount: 40,
      SongCount: 0,
      BookCount: 1,
    });
  json(404, { error: "not found" });
}

const stop = () => {
  catalog.close();
  tailscaled.close();
  appRegistry.close();
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
for (const child of children) child.on("exit", (code) => code && stop());
