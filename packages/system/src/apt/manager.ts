import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  RELEASE_VERSION_PATTERN,
  type AptUpdates,
  type PackageInfo,
  type RemoteAccessProviderId,
} from "@everyos/shared";
import { CommandError, findExecutable, runCapture, runCommand, SAFE_ENV } from "../exec.ts";
import { parseAptPolicy, parseAptShow, parseAptSummary } from "../linux/apt.ts";
import { collectAptUpdates } from "../collect/apt.ts";
import { UnavailableError } from "../unavailable.ts";
import { assertPackageMutationSafe } from "./safety.ts";

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
  /** Installs only the compatible BorgBackup dependency from configured APT repositories. */
  installBorg(signal: AbortSignal): Promise<{ ok: boolean; busy: boolean }>;
  /** Fixed VPN package names only; authentication remains APT's responsibility. */
  installRemoteAccess?(
    provider: RemoteAccessProviderId,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; busy: boolean }>;
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

export function isSupportedBorgPackageVersion(version: string): boolean {
  const match = /^(?:[0-9]+:)?1\.(\d+)\.(\d+)(?:[+-][A-Za-z0-9.+~:-]+)?$/.exec(version);
  return (
    version.length <= 128 &&
    Boolean(match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 5)))
  );
}

export function createAptManager(): AptManager {
  const tool = async (name: string) => {
    const path = await findExecutable(name);
    if (!path) throw new UnavailableError("tool-missing", `${name} is not installed`);
    return path;
  };
  const checkDatabase = async (signal: AbortSignal) => {
    const audit = await runCapture(await tool("dpkg"), ["--audit"], {
      timeoutMs: 20_000,
      signal,
      env: APT_ENV,
      maxOutputBytes: 32 * 1024,
    });
    if (audit.exitCode !== 0 || audit.output.trim())
      throw new CommandError("failed", "PACKAGE_STATE_UNSAFE");
  };
  async function installDependency(
    manager: AptManager,
    name: "borgbackup" | RemoteAccessProviderId,
    signal: AbortSignal,
    borg: boolean,
  ): Promise<{ ok: boolean; busy: boolean }> {
    await assertPackageMutationSafe().catch(() => {
      throw new CommandError("failed", "PACKAGE_ENVIRONMENT_UNSAFE");
    });
    await checkDatabase(signal);
    const aptGet = await tool("apt-get");
    const candidate = (await manager.package(name)).candidateVersion;
    if (!candidate)
      throw new CommandError(
        "failed",
        borg ? "BORG_PACKAGE_UNAVAILABLE" : "REMOTE_PACKAGE_UNAVAILABLE",
      );
    if (borg && !isSupportedBorgPackageVersion(candidate))
      throw new CommandError("failed", "BORG_PACKAGE_VERSION");
    if (!/^[0-9][A-Za-z0-9.+:~_-]{0,127}$/.test(candidate))
      throw new CommandError("failed", "REMOTE_PACKAGE_VERSION");
    const installed = await runCapture(
      await tool("dpkg-query"),
      ["--show", "--showformat=${Version}", "everyos"],
      { timeoutMs: 10_000, signal, env: APT_ENV, maxOutputBytes: 1024 },
    );
    if (installed.exitCode !== 0 && installed.exitCode !== 1)
      throw new CommandError(
        "failed",
        borg ? "BORG_INSTALL_EVERYOS_VERSION" : "REMOTE_INSTALL_EVERYOS_VERSION",
      );
    const everyosVersion = installed.exitCode === 0 ? installed.output.trim() : null;
    if (everyosVersion && !RELEASE_VERSION_PATTERN.test(everyosVersion))
      throw new CommandError(
        "failed",
        borg ? "BORG_INSTALL_EVERYOS_VERSION" : "REMOTE_INSTALL_EVERYOS_VERSION",
      );
    const result = await runCapture(
      aptGet,
      [
        ...UPGRADE_OPTIONS,
        "--no-install-recommends",
        "install",
        "--",
        `${name}=${candidate}`,
        ...(everyosVersion ? [`everyos=${everyosVersion}`] : []),
      ],
      {
        timeoutMs: 20 * 60_000,
        signal,
        env: APT_ENV,
        maxOutputBytes: 64 * 1024,
      },
    );
    if (result.exitCode === 0) await checkDatabase(signal);
    return { ok: result.exitCode === 0, busy: LOCKED.test(result.output) };
  }
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
      // APT list refreshes can also execute administrator-configured hooks.
      await assertPackageMutationSafe().catch(() => {
        throw new CommandError("failed", "PACKAGE_ENVIRONMENT_UNSAFE");
      });
      const aptGet = await tool("apt-get");
      const result = await runCapture(aptGet, ["update"], {
        timeoutMs: 10 * 60_000,
        signal,
        env: APT_ENV,
        maxOutputBytes: 32 * 1024,
      });
      return { ok: result.exitCode === 0, busy: LOCKED.test(result.output), output: result.output };
    },

    async installBorg(signal) {
      return installDependency(this, "borgbackup", signal, true);
    },
    async installRemoteAccess(provider, signal) {
      if (provider !== "tailscale" && provider !== "netbird")
        throw new CommandError("failed", "REMOTE_PROVIDER_INVALID");
      return installDependency(this, provider, signal, false);
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
      if (selected.some((name) => !PACKAGE_NAME.test(name)))
        throw new CommandError("failed", "Invalid package name");
      await assertPackageMutationSafe().catch(() => {
        throw new CommandError("failed", "PACKAGE_ENVIRONMENT_UNSAFE");
      });
      await checkDatabase(signal);
      if (!selected.length) {
        yield { type: "done", ok: true, exitCode: 0, upgraded: 0, busy: false };
        return;
      }
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
      signal.throwIfAborted();
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
        if (exitCode === 0) await checkDatabase(signal);
        yield { type: "done", ok: exitCode === 0, exitCode, upgraded, busy };
      } finally {
        signal.removeEventListener("abort", kill);
        kill();
      }
    },
  };
}
