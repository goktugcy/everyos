import type { BatteryReading, PowerStatus } from "@everyos/shared";
import { listDirOrEmpty, readTextOrNull } from "../fs-utils.ts";
import { hostPath, REAL_HOST, type HostPaths } from "../host-paths.ts";

const number = (text: string | null): number | null => {
  if (!text?.trim()) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
};
const positive = (value: number | null) => (value !== null && value >= 0 ? value : null);
const scaled = (value: number | null, unit: number) => (value === null ? null : value / unit);
const watts = (power: number | null, voltage: number | null, current: number | null) =>
  power !== null
    ? Math.abs(power) / 1e6
    : voltage !== null && current !== null
      ? Math.abs(voltage * current) / 1e12
      : null;
const online = (value: string | null): boolean | null =>
  value?.trim() === "1" ? true : value?.trim() === "0" ? false : null;

/** Fixed, read-only platform operations; no shell, user paths or power-setting commands. */
export async function collectPower(
  options: { paths?: HostPaths; now?: () => number } = {},
): Promise<PowerStatus> {
  const paths = options.paths ?? REAL_HOST;
  const result: PowerStatus = {
    source: "host",
    at: (options.now ?? Date.now)(),
    available: false,
    acConnected: null,
    batteries: [],
    supplies: [],
  };
  if (paths.platform !== "linux") return result;
  const base = hostPath(paths, "/sys/class/power_supply");
  for (const name of (await listDirOrEmpty(base))
    .filter((id) => /^[\w.-]{1,128}$/.test(id))
    .sort()
    .slice(0, 32)) {
    const read = (key: string) => readTextOrNull(`${base}/${name}/${key}`, 128);
    const fields = [
      "type",
      "scope",
      "present",
      "online",
      "capacity",
      "status",
      "power_now",
      "voltage_now",
      "current_now",
      "energy_now",
      "energy_full",
      "time_to_empty_now",
      "time_to_full_now",
      "input_power_limit",
      "voltage_max",
      "current_max",
    ] as const;
    const values = await Promise.all(fields.map(read));
    const value = (key: (typeof fields)[number]) => values[fields.indexOf(key)]?.trim() ?? null;
    const n = (key: (typeof fields)[number]) => number(value(key));
    if (value("scope") === "Device" || value("present") === "0") continue;
    if (value("type") === "Battery" || value("type") === "UPS") {
      const states: Record<string, BatteryReading["state"]> = {
        Charging: "charging",
        Discharging: "discharging",
        Full: "full",
        "Not charging": "not-charging",
      };
      const percent = n("capacity");
      result.batteries.push({
        id: name,
        percent: percent !== null && percent >= 0 && percent <= 100 ? percent : null,
        state: states[value("status") ?? ""] ?? "unknown",
        powerWatts: watts(n("power_now"), n("voltage_now"), n("current_now")),
        voltageVolts: scaled(positive(n("voltage_now")), 1e6),
        currentAmps: scaled(n("current_now"), 1e6),
        energyWh: scaled(positive(n("energy_now")), 1e6),
        fullEnergyWh: scaled(positive(n("energy_full")), 1e6),
        timeToEmptySeconds: positive(n("time_to_empty_now")),
        timeToFullSeconds: positive(n("time_to_full_now")),
      });
    } else if (value("type")) {
      const limit = positive(n("input_power_limit"));
      const voltageMax = positive(n("voltage_max"));
      const currentMax = positive(n("current_max"));
      result.supplies.push({
        id: name,
        online: online(value("online")),
        powerWatts: watts(n("power_now"), n("voltage_now"), n("current_now")),
        powerLimitWatts:
          limit !== null
            ? limit / 1e6
            : voltageMax !== null && currentMax !== null
              ? (voltageMax * currentMax) / 1e12
              : null,
      });
    }
  }
  result.acConnected = result.supplies.some((s) => s.online === true)
    ? true
    : result.supplies.length > 0 && result.supplies.every((s) => s.online === false)
      ? false
      : result.batteries.some((b) => b.state === "charging")
        ? true
        : result.batteries.some((b) => b.state === "discharging")
          ? false
          : null;
  result.available = result.batteries.length > 0 || result.supplies.length > 0;
  return result;
}
