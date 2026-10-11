import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { RELEASE_VERSION_PATTERN, type AptUpdates, type PackageInfo } from "@everyos/shared";
import { CommandError, findExecutable, runCapture, runCommand, SAFE_ENV } from "../exec.ts";
import { parseAptPolicy, parseAptShow, parseAptSummary } from "../linux/apt.ts";
import { collectAptUpdates } from "../collect/apt.ts";
import { UnavailableError } from "../unavailable.ts";

export type AptUpgradeEvent =
  | { type: "line"; text: string }
  | { type: "done"; ok: boolean; exitCode: number | null; upgraded: number | null; busy: boolean };

/** Package management for the update manager; mutations only through apt-get. */
export interface AptManager {
  readonly source: "host" | "simulated";
  updates(): Promise<AptUpdates>;
  package(name: string): Promise<PackageInfo>;
  /** `apt-get update`: refreshes the package lists. */
  refresh(signal: AbortSignal): Promise<{ ok: boolean; busy: boolean; output: string }>;
  /** Upgrades the given packages (only if already installed) or everything; never removes any. */
  upgrade(packages: readonly string[] | null, signal: AbortSignal): AsyncGenerator<AptUpgradeEvent>;
}

export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{0,127}$/;

/** Unattended, non-interactive apt that keeps existing configuration files. */
const APT_ENV = {
  ...SAFE_ENV,
  DEBIAN_FRONTEND: "noninteractive",
  // needrestart (Ubuntu) would otherwise ask which services to restart.
  NEEDRESTART_MODE: "l",
  APT_LISTCHANGES_FRONTEND: "none",
};
const UPGRADE_OPTIONS = [
  "-y",
  "--no-remove",
  "-o",
  "Dpkg::Options::=--force-confdef",
  "-o",
  "Dpkg::Options::=--force-confold",
  "-o",
  "Dpkg::Use-Pty=0",
];
const LOCKED =
  /Could not get lock|Unable to acquire the dpkg frontend lock|is another process using it/;

function summaryOf(text: string): string | null {
  const first = /^(.+?)(?:\n|$)/.exec(text.trim())?.[1];
  return first ? first.slice(0, 200) : null;
}

export function createAptManager(): AptManager {
  const tool = async (name: string) => {
    const path = await findExecutable(name);
    if (!path) throw new UnavailableError("tool-missing", `${name} is not installed`);
    return path;
  };
  return {
    source: "host",
    updates: () => collectAptUpdates(),

    async package(name) {
      if (!PACKAGE_NAME.test(name)) throw new CommandError("failed", "Invalid package name");
      const aptCache = await tool("apt-cache");
      const policy = parseAptPolicy(
        await runCommand(aptCache, ["policy", "--", name], { timeoutMs: 20_000 }),
      );
      const show = parseAptShow(
        await runCommand(aptCache, ["show", "--no-all-versions", "--", name], {
          timeoutMs: 20_000,
        }).catch(() => ""),
      );
      const description = show.Description ?? show["Description-en"] ?? null;
      const size = Number(show["Installed-Size"]);
      return {
        name,
        installedVersion: policy.installed,
        candidateVersion: policy.candidate,
        security: policy.origins.some((origin) => /-security\//.test(origin)),
        section: show.Section?.slice(0, 64) ?? null,
        installedSize: Number.isFinite(size) ? size * 1024 : null,
        summary: description ? summaryOf(description) : null,
        description: description ? description.slice(0, 4000) : null,
        homepage: show.Homepage?.slice(0, 256) ?? null,
        maintainer: show.Maintainer?.slice(0, 256) ?? null,
        origins: policy.origins,
      };
    },

    async refresh(signal) {
      const aptGet = await tool("apt-get");
      const result = await runCapture(aptGet, ["update"], {
        timeoutMs: 10 * 60_000,
        signal,
        env: APT_ENV,
        maxOutputBytes: 32 * 1024,
      });
      return { ok: result.exitCode === 0, busy: LOCKED.test(result.output), output: result.output };
    },

    async *upgrade(packages, signal) {
      if (packages?.some((name) => name.split(":")[0] === "everyos"))
        throw new CommandError(
          "failed",
          "EveryOS must be updated through the signed release workflow",
        );
      if (packages?.some((name) => !PACKAGE_NAME.test(name)))
        throw new CommandError("failed", "Invalid package name");
      const selected =
        packages ??
        (await collectAptUpdates()).packages
          .map((item) => item.name)
          .filter((name) => name !== "everyos");
      if (!selected.length) {
        yield { type: "done", ok: true, exitCode: 0, upgraded: 0, busy: false };
        return;
      }
      if (selected.some((name) => !PACKAGE_NAME.test(name)))
        throw new CommandError("failed", "Invalid package name");
      const aptGet = await tool("apt-get");
      const installed = await runCapture(
        await tool("dpkg-query"),
        ["--show", "--showformat=${Version}", "everyos"],
        { timeoutMs: 10_000, signal, env: APT_ENV, maxOutputBytes: 1024 },
      );
      const everyosVersion = installed.exitCode === 0 ? installed.output.trim() : null;
      if (everyosVersion && !RELEASE_VERSION_PATTERN.test(everyosVersion))
        throw new CommandError("failed", "Unsupported installed EveryOS version");
      const args = [
        ...UPGRADE_OPTIONS,
        "install",
        "--only-upgrade",
        "--",
        ...selected,
        ...(everyosVersion ? [`everyos=${everyosVersion}`] : []),
      ];
      const child = spawn(aptGet, args, { env: APT_ENV, stdio: ["ignore", "pipe", "pipe"] });
      const kill = () => child.exitCode === null && child.kill("SIGTERM");
      signal.addEventListener("abort", kill, { once: true });
      const exit = new Promise<number | null>((resolve) => {
        child.once("close", (code) => resolve(code));
        child.once("error", () => resolve(null));
      });
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      let open = 2;
      for (const stream of [child.stdout, child.stderr]) {
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        lines.on("line", (line) => {
          queue.push(line.slice(0, 2000));
          wake?.();
        });
        lines.on("close", () => {
          open--;
          wake?.();
        });
      }
      let upgraded: number | null = null;
      let busy = false;
      try {
        while (open > 0 || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
            continue;
          }
          const text = queue.shift()!;
          upgraded ??= parseAptSummary(text);
          if (LOCKED.test(text)) busy = true;
          yield { type: "line", text };
        }
        const exitCode = await exit;
        yield { type: "done", ok: exitCode === 0, exitCode, upgraded, busy };
      } finally {
        signal.removeEventListener("abort", kill);
        kill();
      }
    },
  };
}
