/** Read-only telemetry for the managed host, never the browser's battery. */
export const BATTERY_STATES = [
  "charging",
  "discharging",
  "full",
  "not-charging",
  "unknown",
] as const;
export interface BatteryReading {
  id: string;
  percent: number | null;
  state: (typeof BATTERY_STATES)[number];
  powerWatts: number | null;
  voltageVolts: number | null;
  currentAmps: number | null;
  energyWh: number | null;
  fullEnergyWh: number | null;
  timeToEmptySeconds: number | null;
  timeToFullSeconds: number | null;
}
export interface PowerSupplyReading {
  id: string;
  online: boolean | null;
  powerWatts: number | null;
  powerLimitWatts: number | null;
}
export interface PowerStatus {
  source: "host";
  at: number;
  available: boolean;
  acConnected: boolean | null;
  batteries: BatteryReading[];
  supplies: PowerSupplyReading[];
}

/** What an administrator can do with the host's power; `shutdown` powers it off. */
export const POWER_ACTIONS = ["reboot", "shutdown"] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];
/** Seconds between the accepted request and the host acting on it, so clients get an answer. */
export const POWER_DELAY_SECONDS = 5;

/** Whether the host must restart to finish installed updates. */
export interface RebootStatus {
  source: "host" | "simulated";
  required: boolean;
  /** `flag`: the distribution's reboot-required marker; `kernel`: the running kernel's modules are gone. */
  reasons: Array<"flag" | "kernel">;
  /** Packages that asked for the restart, when the distribution lists them. */
  packages: string[];
  kernel: string | null;
}

export interface PowerActionResult {
  source: "host" | "simulated";
  action: PowerAction;
  /** When the host acts (epoch milliseconds). */
  at: number;
}

/** Work a power action would interrupt; `release-install` cannot be overridden. */
export const POWER_BLOCKERS = [
  "release-install",
  "backup",
  "restore",
  "app-jobs",
  "package-upgrade",
  "transfers",
] as const;
export type PowerBlocker = (typeof POWER_BLOCKERS)[number];
