import { DEFAULT_LOCALE, type Locale } from "@everyos/shared";
import { de } from "./locales/de.ts";
import { en } from "./locales/en.ts";
import { es } from "./locales/es.ts";
import { fr } from "./locales/fr.ts";
import { it } from "./locales/it.ts";
import { ja } from "./locales/ja.ts";
import { ko } from "./locales/ko.ts";
import { ru } from "./locales/ru.ts";
import { tr, type LocaleMessages, type Messages } from "./locales/tr.ts";
import { zh } from "./locales/zh.ts";

export type { LocaleMessages, Messages };
export { intlLocaleTag } from "./tags.ts";

/** Every language at once (the server and tests); the browser loads them one by one (client.ts). */
export const resources: Record<Locale, LocaleMessages> = { tr, en, de, es, fr, it, ja, ko, ru, zh };

export const fallbackLocale: Locale = DEFAULT_LOCALE;
