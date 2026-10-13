import type { LocalizedText } from "@everyos/shared";

export function localized(value: LocalizedText, locale: string): string {
  return (
    value[locale] ??
    value[`${locale}_${locale === "tr" ? "TR" : "US"}`] ??
    value.en ??
    value.en_US ??
    Object.values(value)[0] ??
    ""
  );
}
