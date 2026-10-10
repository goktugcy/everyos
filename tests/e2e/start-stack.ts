/**
 * Starts the *built* agent and API (dist/) for end-to-end tests, with all
 * state in a throwaway directory. Run `pnpm build` before `pnpm test:e2e`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
};

const children: ChildProcess[] = [
  spawn(process.execPath, [join(root, "dist/agent/agent.mjs")], { env, stdio: "inherit" }),
  spawn(process.execPath, [join(root, "dist/api/server.mjs")], { env, stdio: "inherit" }),
];

const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
for (const child of children) child.on("exit", (code) => code && stop());
