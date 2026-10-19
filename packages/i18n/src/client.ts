import type { Locale } from "@everyos/shared";
import type { LocaleMessages } from "./locales/tr.ts";

/*
 * The browser's entry: English (the default and fallback) is bundled, every other language is its
 * own chunk loaded when it is chosen, so ten languages do not weigh on the first page load.
 */

export { en } from "./locales/en.ts";
export { tr } from "./locales/tr.ts";
export type { LocaleMessages, Messages } from "./locales/tr.ts";
export { intlLocaleTag } from "./tags.ts";

export const loadMessages: Record<Locale, () => Promise<LocaleMessages>> = {
  tr: () => import("./locales/tr.ts").then((module) => module.tr),
  en: () => import("./locales/en.ts").then((module) => module.en),
  de: () => import("./locales/de.ts").then((module) => module.de),
  es: () => import("./locales/es.ts").then((module) => module.es),
  fr: () => import("./locales/fr.ts").then((module) => module.fr),
  it: () => import("./locales/it.ts").then((module) => module.it),
  ja: () => import("./locales/ja.ts").then((module) => module.ja),
  ko: () => import("./locales/ko.ts").then((module) => module.ko),
  ru: () => import("./locales/ru.ts").then((module) => module.ru),
  zh: () => import("./locales/zh.ts").then((module) => module.zh),
};
