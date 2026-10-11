import type { ServiceAction } from "@everyos/shared";

/**
 * Units EveryOS must never disrupt: the platform itself, remote access paths
 * (SSH, Tailscale) and core OS plumbing. Losing any of them can lock the
 * owner out of a headless server. Patterns use `*` as a wildcard.
 */
export const BUILT_IN_PROTECTED_UNITS = [
  "everyos.service",
  "everyos-api.service",
  "everyos-agent.service",
  "everyos-update.service",
  "run-everyos-app\\x2dconfigs.mount",
  "otuken.service",
  "otuken-agent.service",
  "ssh.service",
  "sshd.service",
  "ssh.socket",
  "tailscaled.service",
  "dbus.service",
  "dbus-broker.service",
  "dbus.socket",
  "polkit.service",
  "NetworkManager.service",
  "wpa_supplicant.service",
  "networking.service",
  "systemd-*.service",
  "systemd-*.socket",
  "getty@*.service",
  "serial-getty@*.service",
  "user@*.service",
  "user-runtime-dir@*.service",
] as const;

/**
 * The only action allowed on a protected unit: starting it cannot interrupt
 * anything and does not change boot configuration. Even `enable` is refused,
 * because some protected units are socket-activated (Ubuntu's ssh.service is
 * started by ssh.socket) and enabling them can conflict at the next boot.
 */
const ALLOWED_ON_PROTECTED: ReadonlySet<ServiceAction> = new Set(["start"]);

export function isAllowedOnProtected(action: ServiceAction): boolean {
  return ALLOWED_ON_PROTECTED.has(action);
}

/** Containers matching these patterns may only be started (configured in agent.yaml). */
export function createContainerProtection(patterns: readonly string[]): (name: string) => boolean {
  const compiled = patterns.map(globToRegExp);
  return (name) => compiled.some((pattern) => pattern.test(name));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}

export function createUnitProtection(extra: readonly string[] = []): (unit: string) => boolean {
  const patterns = [...BUILT_IN_PROTECTED_UNITS, ...extra].map(globToRegExp);
  return (unit) => patterns.some((pattern) => pattern.test(unit));
}
