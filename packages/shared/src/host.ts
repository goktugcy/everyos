/*
 * Zod-free constants for host integration (metrics, services, logs,
 * network). Runtime schemas live in "@otuken/shared/schemas" (schemas/host.ts).
 */

export const SERVICE_ACTIONS = ["start", "stop", "restart", "reload", "enable", "disable"] as const;

export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** systemd unit names Otuken accepts (no paths, no options, no globbing). */
export const UNIT_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9:_.\\@-]{0,250}\.(service|socket|timer|target|path|mount)$/;

export function isValidUnitName(value: string): boolean {
  return UNIT_NAME_PATTERN.test(value) && !value.includes("..");
}

/** syslog priorities as used by journald (0 = emerg … 7 = debug). */
export const LOG_PRIORITIES = [
  "emerg",
  "alert",
  "crit",
  "err",
  "warning",
  "notice",
  "info",
  "debug",
] as const;

export type LogPriorityName = (typeof LOG_PRIORITIES)[number];

export const NETWORK_INTERFACE_KINDS = [
  "ethernet",
  "wireless",
  "loopback",
  "tailscale",
  "bridge",
  "virtual",
  "other",
] as const;

export type NetworkInterfaceKind = (typeof NETWORK_INTERFACE_KINDS)[number];

export const INTERNET_STATES = ["online", "offline", "unknown", "disabled"] as const;

export type InternetState = (typeof INTERNET_STATES)[number];

/** Raspberry Pi firmware throttling flags (vcgencmd get_throttled bits). */
export const THROTTLE_FLAGS = [
  "underVoltage",
  "frequencyCapped",
  "throttled",
  "softTempLimit",
  "underVoltageOccurred",
  "frequencyCappedOccurred",
  "throttledOccurred",
  "softTempLimitOccurred",
] as const;

export type ThrottleFlag = (typeof THROTTLE_FLAGS)[number];

/** Time ranges offered for metric history. */
export const METRIC_RANGES = ["15m", "1h", "24h"] as const;

export type MetricRange = (typeof METRIC_RANGES)[number];

/* ------------------------------ metrics ------------------------------ */

/**
 * One point of derived metrics, computed by the API from two consecutive raw
 * samples. `null` means "not measurable on this host", never zero.
 */
export interface MetricsPoint {
  at: number;
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
  load1: number | null;
  netRxBytesPerSec: number | null;
  netTxBytesPerSec: number | null;
  diskReadBytesPerSec: number | null;
  diskWriteBytesPerSec: number | null;
  temperatureC: number | null;
}

/** Live snapshot pushed over the event stream (topic "metrics"). */
export interface MetricsSnapshot {
  source: "host" | "simulated";
  point: MetricsPoint;
  uptimeSeconds: number;
  load: [number, number, number] | null;
  cpuCores: number[] | null;
  cpuFrequencyMHz: number[] | null;
  interfaces: Array<{ name: string; rxBytesPerSec: number; txBytesPerSec: number }> | null;
  disks: Array<{
    name: string;
    readBytesPerSec: number;
    writeBytesPerSec: number;
    busyPercent: number;
  }> | null;
  thermal: Array<{ zone: string; type: string; celsius: number }> | null;
  fans: Array<{ name: string; rpm: number }> | null;
}

export interface MetricsHistory {
  range: MetricRange;
  /** Spacing of the returned points in milliseconds. */
  resolutionMs: number;
  points: MetricsPoint[];
}

/** Topics of the shared server-sent event stream (`GET /api/events`). */
export const EVENT_TOPICS = ["metrics", "docker"] as const;

export type EventTopic = (typeof EVENT_TOPICS)[number];
