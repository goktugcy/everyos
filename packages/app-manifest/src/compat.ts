import type { AppManifest } from "./types.ts";
import { compareVersions, satisfies } from "./version.ts";

export type IncompatibleReason = "everyos-too-old" | "sdk-unsupported";

export type Compatibility = { ok: true } | { ok: false; reason: IncompatibleReason };

/** Whether this EveryOS (release and bridge protocol) can run the app. */
export function checkCompatibility(
  manifest: Pick<AppManifest, "minEveryOS" | "sdk">,
  host: { everyosVersion: string; sdkVersion: string },
): Compatibility {
  if (manifest.minEveryOS && compareVersions(host.everyosVersion, manifest.minEveryOS) < 0)
    return { ok: false, reason: "everyos-too-old" };
  if (!satisfies(host.sdkVersion, manifest.sdk)) return { ok: false, reason: "sdk-unsupported" };
  return { ok: true };
}
