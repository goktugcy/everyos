import { intlLocaleTag } from "@otuken/i18n";
import { isLocale } from "@otuken/shared";

export function localeTag(language: string): string {
  return isLocale(language) ? intlLocaleTag[language] : language;
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
