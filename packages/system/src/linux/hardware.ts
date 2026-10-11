import { THROTTLE_FLAGS, type HardwareStatus, type ThrottleFlag } from "@everyos/shared";

/**
 * Raspberry Pi firmware throttling state (`vcgencmd get_throttled` or the
 * firmware sysfs node). Bits 0–3 describe the current state, 16–19 whether
 * the condition occurred since boot.
 */
const THROTTLE_BITS: Record<ThrottleFlag, number> = {
  underVoltage: 0,
  frequencyCapped: 1,
  throttled: 2,
  softTempLimit: 3,
  underVoltageOccurred: 16,
  frequencyCappedOccurred: 17,
  throttledOccurred: 18,
  softTempLimitOccurred: 19,
};

export function parseThrottled(
  text: string,
): { raw: string; flags: Record<ThrottleFlag, boolean> } | null {
  const match = /(?:throttled=)?(0x[0-9a-f]+|\d+)/i.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const flags = Object.fromEntries(
    THROTTLE_FLAGS.map((flag) => [flag, (value & (1 << THROTTLE_BITS[flag])) !== 0]),
  ) as Record<ThrottleFlag, boolean>;
  return { raw: `0x${value.toString(16)}`, flags };
}

type NvmeDevice = HardwareStatus["nvme"]["devices"][number];

const numOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** `smartctl --json -a /dev/nvmeX` (smartmontools ≥ 7) → health summary. */
export function parseSmartctl(json: unknown, device: string): NvmeDevice | null {
  if (typeof json !== "object" || json === null) return null;
  const data = json as Record<string, unknown>;
  const log = data.nvme_smart_health_information_log as Record<string, unknown> | undefined;
  if (!log) return null;
  const status = data.smart_status as { passed?: unknown } | undefined;
  const temperature =
    (data.temperature as { current?: unknown } | undefined)?.current ?? log.temperature;
  return {
    device,
    model: typeof data.model_name === "string" ? data.model_name.slice(0, 128) : null,
    temperatureC: numOrNull(temperature),
    percentageUsed: numOrNull(log.percentage_used),
    availableSparePercent: numOrNull(log.available_spare),
    powerOnHours: numOrNull(log.power_on_hours),
    mediaErrors: numOrNull(log.media_errors),
    criticalWarning: numOrNull(log.critical_warning),
    healthy: typeof status?.passed === "boolean" ? status.passed : null,
  };
}
