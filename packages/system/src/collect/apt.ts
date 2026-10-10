import { stat } from "node:fs/promises";
import type { AptUpdates } from "@otuken/shared";
import { findExecutable, runCommand } from "../exec.ts";
import { parseAptUpgradable } from "../linux/apt.ts";
import { UnavailableError } from "../unavailable.ts";

async function listsUpdatedAt(): Promise<number | null> {
  for (const path of [
    "/var/lib/apt/periodic/update-success-stamp",
    "/var/cache/apt/pkgcache.bin",
  ]) {
    const info = await stat(path).catch(() => null);
    if (info) return info.mtimeMs;
  }
  return null;
}

/**
 * Pending package updates from the local package lists. Read-only: Otuken
 * never runs `apt update`; the lists are as fresh as apt's own timers left them.
 */
export async function collectAptUpdates(): Promise<AptUpdates> {
  const apt = await findExecutable("apt");
  if (!apt) throw new UnavailableError("tool-missing", "apt is not installed");
  const output = await runCommand(apt, ["list", "--upgradable"], {
    timeoutMs: 60_000,
    maxBytes: 8 * 1024 * 1024,
  });
  return { source: "host", listsUpdatedAt: await listsUpdatedAt(), ...parseAptUpgradable(output) };
}
