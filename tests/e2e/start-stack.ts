/**
 * Starts the *built* agent and API (dist/) for end-to-end tests, with all
 * state in a throwaway directory. Run `pnpm build` before `pnpm test:e2e`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
export const E2E_STATE_DIR = join(here, ".state");
export const E2E_PORT = Number(process.env.OTUKEN_E2E_PORT ?? 7480);

if (!existsSync(join(root, "dist/api/server.mjs"))) {
  console.error("dist/ is missing. Run `pnpm build` first.");
  process.exit(1);
}

rmSync(E2E_STATE_DIR, { recursive: true, force: true });
mkdirSync(E2E_STATE_DIR, { recursive: true });

const env = {
  ...process.env,
  OTUKEN_ENV: "development",
  OTUKEN_DEV_ROOT: E2E_STATE_DIR,
  OTUKEN_WEB_DIR: join(root, "dist/web"),
  OTUKEN_PORT: String(E2E_PORT),
  OTUKEN_LOG_LEVEL: "warn",
  // Deterministic systemd/journald data on every OS (CI runners have real systemd).
  OTUKEN_AGENT_SIMULATE: "1",
};

const children: ChildProcess[] = [
  spawn(process.execPath, [join(root, "dist/agent/agent.mjs")], { env, stdio: "inherit" }),
  spawn(process.execPath, [join(root, "dist/api/server.mjs")], { env, stdio: "inherit" }),
];

// Original catalog fixture served over HTTP to exercise the real safe fetcher.
// Installed containers still use the explicitly labeled Docker simulator.
const catalog = createServer((request, response) => {
  if (request.url !== "/catalog.yml") {
    response.writeHead(404);
    response.end();
    return;
  }
  response.setHeader("Content-Type", "text/yaml");
  response.end(
    "services:\n  demo:\n    image: example.invalid/original-e2e:1.0\n    ports: ['8765:80']\n    volumes: ['${APP_DATA_DIR}/data:/data:ro']\n    environment:\n      APP_TOKEN: ${APP_TOKEN}\n      PASSWORD: ${SERVICE_PASSWORD_64_DEMO}\nx-casaos:\n  id: original-e2e\n  title: {tr_TR: Deneme Uygulaması, en_US: Test Application}\n  description: {tr_TR: İzole uçtan uca test kataloğu., en_US: Isolated end-to-end test catalog.}\n  architectures: [amd64, arm64]\n",
  );
});
catalog.listen(E2E_PORT + 1, "127.0.0.1");

const stop = () => {
  catalog.close();
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
for (const child of children) child.on("exit", (code) => code && stop());
