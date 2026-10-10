export const SUPPORTED_LOCALES = ["tr", "en"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Turkish is the product default. */
export const DEFAULT_LOCALE: Locale = "tr";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Picks the best supported locale from a list of BCP 47 tags (e.g. navigator.languages). */
export function negotiateLocale(candidates: readonly string[]): Locale {
  for (const candidate of candidates) {
    const base = candidate.toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
