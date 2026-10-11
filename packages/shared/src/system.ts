/**
 * Host capabilities are detected at runtime. A capability that is not
 * available always carries a machine-readable reason so the UI can explain
 * why data is missing instead of showing fabricated values.
 */
export const CAPABILITY_IDS = [
  "procfs",
  "systemd",
  "journald",
  "docker",
  "tailscale",
  "thermal",
  "raspberryPi",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export const CAPABILITY_REASONS = [
  "not-linux",
  "not-detected",
  "socket-missing",
  "permission-denied",
  "unsupported-hardware",
  "tool-missing",
] as const;

export type CapabilityReason = (typeof CAPABILITY_REASONS)[number];

/**
 * `host` — values were read from the machine EveryOS runs on.
 * `simulated` — development-only synthetic values; the UI must label them.
 */
export const DATA_SOURCES = ["host", "simulated"] as const;

export type DataSource = (typeof DATA_SOURCES)[number];
