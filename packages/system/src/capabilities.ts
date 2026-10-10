import type { CapabilityId, CapabilityStatus } from "@otuken/shared";
import { listDirOrEmpty, pathKind } from "./fs-utils.ts";
import { hostPath, type HostPaths } from "./host-paths.ts";

const available: CapabilityStatus = { available: true };
const notLinux: CapabilityStatus = { available: false, reason: "not-linux" };

async function firstSocket(paths: HostPaths, candidates: string[]): Promise<CapabilityStatus> {
  let denied = false;
  for (const candidate of candidates) {
    const kind = await pathKind(hostPath(paths, candidate));
    if (kind === "socket") return available;
    if (kind === "denied") denied = true;
  }
  return { available: false, reason: denied ? "permission-denied" : "socket-missing" };
}

/**
 * Detects what this host can provide. Detection only checks for interfaces;
 * it never starts services or installs tools.
 */
export async function detectCapabilities(
  paths: HostPaths,
  hardwareModel: string | null,
): Promise<Record<CapabilityId, CapabilityStatus>> {
  const linux = paths.platform === "linux";

  const docker = await firstSocket(paths, ["/var/run/docker.sock", "/run/docker.sock"]);
  const tailscaleSocket = await firstSocket(paths, [
    "/var/run/tailscale/tailscaled.sock",
    "/run/tailscale/tailscaled.sock",
  ]);
  const tailscale: CapabilityStatus = tailscaleSocket.available
    ? available
    : {
        available: false,
        reason:
          tailscaleSocket.reason === "permission-denied" ? "permission-denied" : "not-detected",
      };

  if (!linux) {
    return {
      procfs: notLinux,
      systemd: notLinux,
      journald: notLinux,
      docker,
      tailscale,
      thermal: notLinux,
      raspberryPi: notLinux,
    };
  }

  const procfs =
    (await pathKind(hostPath(paths, "/proc/stat"))) === "file"
      ? available
      : { available: false, reason: "not-detected" as const };
  // Same test as sd_booted(3): systemd is PID 1 when this directory exists.
  const systemd =
    (await pathKind(hostPath(paths, "/run/systemd/system"))) === "directory"
      ? available
      : { available: false, reason: "not-detected" as const };
  const journalSocket = await pathKind(hostPath(paths, "/run/systemd/journal/socket"));
  const journald =
    journalSocket === "socket" ? available : { available: false, reason: "not-detected" as const };
  const zones = (await listDirOrEmpty(hostPath(paths, "/sys/class/thermal"))).filter((name) =>
    name.startsWith("thermal_zone"),
  );
  const thermal =
    zones.length > 0 ? available : { available: false, reason: "unsupported-hardware" as const };
  const raspberryPi = hardwareModel?.includes("Raspberry Pi")
    ? available
    : { available: false, reason: "unsupported-hardware" as const };

  return { procfs, systemd, journald, docker, tailscale, thermal, raspberryPi };
}
