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
