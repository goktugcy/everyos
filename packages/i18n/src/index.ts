import { DEFAULT_LOCALE, type Locale } from "@everyos/shared";
import { en } from "./locales/en.ts";
import { tr, type Messages } from "./locales/tr.ts";

export type { Messages };

export const resources: Record<Locale, Messages> = { tr, en };

export const fallbackLocale: Locale = DEFAULT_LOCALE;

/** BCP 47 tags used with the Intl APIs for dates, times and numbers. */
export const intlLocaleTag: Record<Locale, string> = {
  tr: "tr-TR",
  en: "en-GB",
};
