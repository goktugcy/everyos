import type { LocalizedText } from "@everyos/shared";

/** Catalogs (CasaOS style) key translations by language and region, e.g. `zh_CN`. */
const REGIONAL: Record<string, string> = {
  tr: "tr_TR",
  en: "en_US",
  de: "de_DE",
  es: "es_ES",
  fr: "fr_FR",
  it: "it_IT",
  ja: "ja_JP",
  ko: "ko_KR",
  ru: "ru_RU",
  zh: "zh_CN",
};

export function localized(value: LocalizedText, locale: string): string {
  return (
    value[locale] ??
    value[REGIONAL[locale] ?? ""] ??
    value.en ??
    value.en_US ??
    Object.values(value)[0] ??
    ""
  );
}
