/**
 * `pnpm dev` — runs the agent, the API and the Vite dev server together.
 *
 * Development mode is deliberately unprivileged: all state lives in ./.dev,
 * the agent refuses to run as root, and nothing on the host is modified.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const devRoot = join(root, ".dev");
for (const dir of ["data", "run", "secrets"])
  mkdirSync(join(devRoot, dir), { recursive: true, mode: 0o700 });

if (process.getuid?.() === 0) {
  console.error("Refusing to start the development environment as root.");
  process.exit(1);
}

const env = {
  ...process.env,
  EVERYOS_ENV: "development",
  EVERYOS_DEV_ROOT: devRoot,
  FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
};

const colors = { agent: "\u001b[35m", api: "\u001b[36m", web: "\u001b[32m" } as const;
type Name = keyof typeof colors;

const children: ChildProcess[] = [];
let exiting = false;

function prefixLines(name: Name, chunk: Buffer, target: NodeJS.WriteStream): void {
  const label = `${colors[name]}${name.padEnd(5)}\u001b[0m│ `;
  const text = chunk.toString();
  target.write(
    text
      .split("\n")
      .map((line, index, all) => (index === all.length - 1 && line === "" ? "" : `${label}${line}`))
      .join("\n"),
  );
}

function run(name: Name, command: string, args: string[], cwd: string): void {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout?.on("data", (chunk: Buffer) => prefixLines(name, chunk, process.stdout));
  child.stderr?.on("data", (chunk: Buffer) => prefixLines(name, chunk, process.stderr));
  child.on("exit", (code, signal) => {
    if (exiting) return;
    console.error(`${name} exited (${signal ?? code}); stopping the development environment.`);
    shutdown(code ?? 1);
  });
}

function shutdown(code: number): void {
  if (exiting) return;
  exiting = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1_500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

/**
 * Resolves Vite's CLI from the web workspace. pnpm installs it only under
 * apps/web/node_modules (it is not a root dependency).
 */
function resolveViteCli(): string {
  const webRequire = createRequire(join(root, "apps/web/package.json"));
  const manifestPath = webRequire.resolve("vite/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin: { vite: string } };
  return join(dirname(manifestPath), manifest.bin.vite);
}

const node = process.execPath;
run("agent", node, ["--watch", "--watch-preserve-output", "src/main.ts"], join(root, "apps/agent"));
run("api", node, ["--watch", "--watch-preserve-output", "src/main.ts"], join(root, "apps/api"));
run("web", node, [resolveViteCli()], join(root, "apps/web"));

console.log(
  `\nEveryOS development environment\n  web  → http://127.0.0.1:5173\n  api  → http://127.0.0.1:7470\n  data → ${devRoot}\n`,
);
