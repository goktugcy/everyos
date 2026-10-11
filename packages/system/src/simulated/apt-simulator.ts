import type { AptUpdates, PackageInfo } from "@everyos/shared";
import type { AptManager, AptUpgradeEvent } from "../apt/manager.ts";

const PACKAGES: AptUpdates["packages"] = [
  {
    name: "openssl",
    version: "3.0.13-0ubuntu3.6",
    currentVersion: "3.0.13-0ubuntu3.5",
    suites: "noble-updates,noble-security",
    security: true,
  },
  {
    name: "libssl3t64",
    version: "3.0.13-0ubuntu3.6",
    currentVersion: "3.0.13-0ubuntu3.5",
    suites: "noble-updates,noble-security",
    security: true,
  },
  {
    name: "curl",
    version: "8.5.0-2ubuntu10.7",
    currentVersion: "8.5.0-2ubuntu10.6",
    suites: "noble-updates",
    security: false,
  },
  {
    name: "tzdata",
    version: "2026a-0ubuntu0.24.04",
    currentVersion: "2025b-0ubuntu0.24.04",
    suites: "noble-updates",
    security: false,
  },
  {
    name: "docker-ce",
    version: "5:29.8.0-1~ubuntu.24.04~noble",
    currentVersion: "5:29.7.0-1~ubuntu.24.04~noble",
    suites: "noble",
    security: false,
  },
];

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Development stand-in for apt (labelled "simulated"); upgrades only change
 * this in-memory list. Never used in production.
 */
export function createAptSimulator(now: () => number = Date.now): AptManager {
  let pending = [...PACKAGES];
  let listsUpdatedAt = now() - 6 * 60 * 60_000;
  const updates = (): AptUpdates => ({
    source: "simulated",
    listsUpdatedAt,
    total: pending.length,
    security: pending.filter((p) => p.security).length,
    // Same order as the real parser: security updates first, then by name.
    packages: [...pending].sort(
      (a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name),
    ),
  });
  return {
    source: "simulated",
    updates: () => Promise.resolve(updates()),
    package(name) {
      const entry = pending.find((p) => p.name === name) ?? PACKAGES.find((p) => p.name === name);
      const info: PackageInfo = {
        name,
        installedVersion: entry?.currentVersion ?? null,
        candidateVersion: entry?.version ?? null,
        security: entry?.security ?? false,
        section: "utils",
        installedSize: 2_400_000,
        summary: `${name} (simulated package)`,
        description: `${name} (simulated package)\nDevelopment data, not read from this computer.`,
        homepage: null,
        maintainer: "EveryOS simulator",
        origins: entry ? entry.suites.split(",").map((suite) => `${suite}/main`) : [],
      };
      return Promise.resolve(info);
    },
    async refresh(signal) {
      await wait(300, signal);
      listsUpdatedAt = now();
      return {
        ok: true,
        busy: false,
        output: "Hit:1 simulated noble InRelease\nReading package lists... Done\n",
      };
    },
    async *upgrade(packages, signal): AsyncGenerator<AptUpgradeEvent> {
      const targets = pending.filter((p) => packages === null || packages.includes(p.name));
      yield { type: "line", text: "Reading package lists... (simulated)" };
      for (const target of targets) {
        await wait(150, signal);
        if (signal.aborted) return;
        yield {
          type: "line",
          text: `Unpacking ${target.name} (${target.version}) over (${target.currentVersion}) ...`,
        };
        yield { type: "line", text: `Setting up ${target.name} (${target.version}) ...` };
      }
      pending = pending.filter((p) => !targets.includes(p));
      yield {
        type: "line",
        text: `${targets.length} upgraded, 0 newly installed, 0 to remove and ${pending.length} not upgraded.`,
      };
      yield { type: "done", ok: true, exitCode: 0, upgraded: targets.length, busy: false };
    },
  };
}
