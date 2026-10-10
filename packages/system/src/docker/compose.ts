import { homedir } from "node:os";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import type { ComposeAction, ComposeActionResult, ComposeFileCheck } from "@otuken/shared";
import { parse as parseYaml } from "yaml";
import { CommandError, findExecutable, runCapture, SAFE_ENV } from "../exec.ts";
import { sanitizeLogText } from "../linux/journal.ts";

const MAX_COMPOSE_FILE_BYTES = 512 * 1024;
const COMPOSE_TIMEOUT_MS = 10 * 60_000;
const ABSOLUTE_YAML = /^\/[^\0]*\.ya?ml$/;

type FileResult = ComposeFileCheck["files"][number];

function normalizedAbsolute(path: string): boolean {
  return path.startsWith("/") && !path.split("/").some((part) => part === "." || part === "..");
}

/**
 * Validates one Compose file on the host. Paths come from container labels
 * (which an image can set), so the agent only accepts absolute, normalized
 * `.yml`/`.yaml` paths to regular files that actually parse as Compose
 * documents with a `services` mapping. File contents are never returned.
 */
export async function checkComposeFile(path: string): Promise<FileResult> {
  const result = (reason: FileResult["reason"]): FileResult => ({
    path: path.slice(0, 1024),
    ok: reason === "ok",
    reason,
  });
  if (!ABSOLUTE_YAML.test(path) || !normalizedAbsolute(path)) return result("invalid-path");
  try {
    await lstat(path);
  } catch {
    return result("missing");
  }
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    return result("missing");
  }
  if (!ABSOLUTE_YAML.test(resolved)) return result("invalid-path");
  const info = await stat(resolved);
  if (!info.isFile()) return result("not-regular");
  if (info.size > MAX_COMPOSE_FILE_BYTES) return result("too-large");
  let text: string;
  try {
    text = await readFile(resolved, "utf8");
  } catch {
    return result("unreadable");
  }
  try {
    const document: unknown = parseYaml(text, { maxAliasCount: 100 });
    const services = (document as { services?: unknown } | null)?.services;
    return services !== null && typeof services === "object" && !Array.isArray(services)
      ? result("ok")
      : result("not-compose");
  } catch {
    return result("not-compose");
  }
}

export async function checkComposeFiles(
  project: string,
  workingDir: string | null,
  files: readonly string[],
): Promise<ComposeFileCheck> {
  return {
    project,
    workingDir,
    files: await Promise.all(files.slice(0, 16).map((file) => checkComposeFile(file))),
  };
}

const ACTION_STEPS: Record<ComposeAction, string[][]> = {
  up: [["up", "--detach"]],
  start: [["start"]],
  stop: [["stop"]],
  restart: [["restart"]],
  update: [["pull"], ["up", "--detach"]],
  // Never `-v` (volumes) or `--rmi` (images): data and images always survive.
  down: [["down"]],
};

export class ComposeError extends Error {
  readonly kind: "unavailable" | "invalid";

  constructor(kind: ComposeError["kind"], message: string) {
    super(message);
    this.name = "ComposeError";
    this.kind = kind;
  }
}

let composeVersion: Promise<string | null> | null = null;

/** Version of the `docker compose` plugin, or null when it is not installed. */
export function detectCompose(): Promise<string | null> {
  composeVersion ??= (async () => {
    const docker = await findExecutable("docker");
    if (!docker) return null;
    try {
      const result = await runCapture(docker, ["compose", "version", "--short"], {
        timeoutMs: 10_000,
      });
      return result.exitCode === 0 ? result.output.trim().slice(0, 64) || null : null;
    } catch {
      return null;
    }
  })();
  return composeVersion;
}

/**
 * Runs a Compose action for a project whose files were validated. Arguments
 * are fixed per action; the project name, directory and files are passed as
 * separate arguments (never through a shell).
 */
export async function runCompose(
  project: string,
  workingDir: string,
  files: readonly string[],
  action: ComposeAction,
  socketPath: string,
  signal?: AbortSignal,
  input?: string,
): Promise<ComposeActionResult> {
  if (!normalizedAbsolute(workingDir))
    throw new ComposeError("invalid", "Invalid project directory");
  const directory = await stat(workingDir).catch(() => null);
  if (!directory?.isDirectory())
    throw new ComposeError("invalid", "Project directory does not exist");
  if (input === undefined) {
    const checks = await Promise.all(files.map((file) => checkComposeFile(file)));
    if (checks.length === 0 || checks.some((check) => !check.ok))
      throw new ComposeError("invalid", "Compose files failed validation");
  } else {
    if (files.length || Buffer.byteLength(input) > MAX_COMPOSE_FILE_BYTES)
      throw new ComposeError("invalid", "Invalid managed Compose input");
    const doc: unknown = parseYaml(input, { maxAliasCount: 50 });
    if (!doc || typeof doc !== "object" || !Object.hasOwn(doc, "services"))
      throw new ComposeError("invalid", "Invalid managed Compose input");
  }
  const docker = await findExecutable("docker");
  if (!docker || (await detectCompose()) === null)
    throw new ComposeError("unavailable", "docker compose is not installed");

  const base = [
    "compose",
    "--ansi",
    "never",
    "--project-name",
    project,
    "--project-directory",
    workingDir,
    ...(input === undefined ? files.flatMap((file) => ["--file", file]) : ["--file", "-"]),
  ];
  // HOME lets the CLI find registry credentials of the account the agent runs as.
  // Bind Compose to the same daemon as discovery, regardless of the user's CLI context.
  const env = {
    ...SAFE_ENV,
    HOME: homedir(),
    DOCKER_HOST: `unix://${socketPath}`,
    COMPOSE_PROGRESS: "plain",
  };
  let output = "";
  const deadline = Date.now() + COMPOSE_TIMEOUT_MS;
  for (const originalStep of ACTION_STEPS[action]) {
    const step =
      input !== undefined && originalStep[0] === "up"
        ? [...originalStep, "--wait", "--wait-timeout", "120"]
        : originalStep;
    try {
      const result = await runCapture(docker, [...base, ...step], {
        timeoutMs: Math.max(1, deadline - Date.now()),
        env,
        cwd: workingDir,
        ...(signal ? { signal } : {}),
        ...(input !== undefined ? { input, maxOutputBytes: 0 } : {}),
      });
      output += result.output;
      if (result.exitCode !== 0) return { ok: false, output: tail(output) };
    } catch (error) {
      if (error instanceof CommandError && error.kind === "not-found")
        throw new ComposeError("unavailable", "docker is not installed");
      throw error;
    }
  }
  return { ok: true, output: tail(output) };
}

function tail(output: string): string {
  return sanitizeLogText(output.slice(-16_000));
}
