import { intlLocaleTag } from "@everyos/i18n/client";
import { isLocale } from "@everyos/shared";

export function localeTag(language: string): string {
  return isLocale(language) ? intlLocaleTag[language] : language;
}

/**
 * Up to `count` initials of a name, capitalized the way its owner's language does: a Turkish
 * "irmak" starts with "İ", an English "ivan" with "I".
 */
export function initials(name: string, language: string, count = 2): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, count)
      .map((part) => [...part][0]!.toLocaleUpperCase(localeTag(language)))
      .join("") || "?"
  );
}

/** Binary units (KiB, MiB, GiB…), the convention used by Linux tools. */
export function formatBytes(bytes: number, language: string): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${new Intl.NumberFormat(localeTag(language), { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/** Compact, localized duration such as "3 gün 4 sa" / "3 days 4 hr". */
export function formatDuration(totalSeconds: number, language: string): string {
  const tag = localeTag(language);
  const parts: Array<[number, "day" | "hour" | "minute"]> = [
    [Math.floor(totalSeconds / 86_400), "day"],
    [Math.floor((totalSeconds % 86_400) / 3_600), "hour"],
    [Math.floor((totalSeconds % 3_600) / 60), "minute"],
  ];
  const shown = parts.filter(([value]) => value > 0).slice(0, 2);
  if (shown.length === 0) shown.push([0, "minute"]);
  return shown
    .map(([value, unit]) =>
      new Intl.NumberFormat(tag, { style: "unit", unit, unitDisplay: "short" }).format(value),
    )
    .join(" ");
}

export function formatDateTime(
  timestamp: number,
  language: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(
    localeTag(language),
    options ?? { dateStyle: "medium", timeStyle: "short" },
  ).format(timestamp);
}

/** Percentage of a 0–100 value, localized ("%45" in Turkish, "45%" in English). */
export function formatPercent(value: number, language: string, digits = 0): string {
  return new Intl.NumberFormat(localeTag(language), {
    style: "percent",
    maximumFractionDigits: digits,
  }).format(value / 100);
}

export function formatCelsius(value: number, language: string): string {
  return new Intl.NumberFormat(localeTag(language), {
    style: "unit",
    unit: "celsius",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatNumber(value: number, language: string, digits = 0): string {
  return new Intl.NumberFormat(localeTag(language), { maximumFractionDigits: digits }).format(
    value,
  );
}

/** Clock time for chart axes and log rows. */
export function formatClock(timestamp: number, language: string, seconds = false): string {
  return new Intl.DateTimeFormat(localeTag(language), {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  }).format(timestamp);
}

/** "5 dakika önce" / "5 minutes ago"; dates for anything older than a week. */
export function formatRelative(timestamp: number, language: string, now = Date.now()): string {
  const seconds = Math.round((timestamp - now) / 1000);
  const abs = Math.abs(seconds);
  const format = new Intl.RelativeTimeFormat(localeTag(language), { numeric: "auto" });
  if (abs < 45) return format.format(0, "second");
  if (abs < 3_600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3_600), "hour");
  if (abs < 7 * 86_400) return format.format(Math.round(seconds / 86_400), "day");
  return formatDateTime(timestamp, language, { dateStyle: "medium" });
}
