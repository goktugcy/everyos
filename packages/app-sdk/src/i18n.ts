/** Nested message objects, as in an app's `locales/<locale>.json`. */
export interface Messages {
  [key: string]: string | Messages;
}

export interface I18n {
  readonly locale: string;
  /** BCP 47 tag for Intl formatting (the same regions EveryOS uses). */
  readonly tag: string;
  /**
   * The message for a dotted key, with `{{name}}` placeholders filled. With a numeric `count`,
   * plural forms (`key_one`, `key_other`, … per the language's rules) are chosen. Missing keys fall
   * back to the default language, then to the key itself.
   */
  t(key: string, values?: Record<string, string | number>): string;
  setLocale(locale: string): Promise<void>;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  date(value: number | Date, options?: Intl.DateTimeFormatOptions): string;
}

const TAGS: Record<string, string> = {
  tr: "tr-TR",
  en: "en-GB",
  de: "de-DE",
  es: "es-ES",
  fr: "fr-FR",
  it: "it-IT",
  ja: "ja-JP",
  ko: "ko-KR",
  ru: "ru-RU",
  zh: "zh-CN",
};

function lookup(messages: Messages | undefined, key: string): string | undefined {
  let node: string | Messages | undefined = messages;
  for (const part of key.split(".")) {
    if (node === undefined || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Loads `<path>/<locale>.json` next to the app's document (its own package files). */
export function packageMessages(path = "locales"): (locale: string) => Promise<Messages> {
  return async (locale) => {
    const response = await fetch(new URL(`${path}/${locale}.json`, document.baseURI));
    if (!response.ok) throw new Error(`Missing messages for ${locale}`);
    return (await response.json()) as Messages;
  };
}

export async function createI18n(options: {
  locale: string;
  supported: readonly string[];
  /** The language every key exists in (`en` for official apps). */
  fallback?: string;
  load?: (locale: string) => Promise<Messages> | Messages;
}): Promise<I18n> {
  const fallback = options.fallback ?? "en";
  const load = options.load ?? packageMessages();
  const cache = new Map<string, Messages>();
  const get = async (locale: string) => {
    let messages = cache.get(locale);
    if (!messages) {
      messages = await load(locale);
      cache.set(locale, messages);
    }
    return messages;
  };
  const pick = (locale: string) => (options.supported.includes(locale) ? locale : fallback);
  const base = await get(fallback);
  let locale = pick(options.locale);
  let messages = await get(locale);
  let plural = new Intl.PluralRules(TAGS[locale] ?? locale);

  const i18n: I18n = {
    get locale() {
      return locale;
    },
    get tag() {
      return TAGS[locale] ?? locale;
    },
    t(key, values) {
      let text: string | undefined;
      const count = values?.count;
      if (typeof count === "number") {
        const form = `${key}_${plural.select(count)}`;
        text = lookup(messages, form) ?? lookup(messages, `${key}_other`);
        text ??= lookup(
          base,
          `${key}_${new Intl.PluralRules(TAGS[fallback] ?? fallback).select(count)}`,
        );
        text ??= lookup(base, `${key}_other`);
      }
      text ??= lookup(messages, key) ?? lookup(base, key) ?? key;
      return values
        ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
            name in values ? String(values[name]) : match,
          )
        : text;
    },
    async setLocale(next) {
      const chosen = pick(next);
      messages = await get(chosen);
      locale = chosen;
      plural = new Intl.PluralRules(TAGS[locale] ?? locale);
    },
    number: (value, formatOptions) => new Intl.NumberFormat(i18n.tag, formatOptions).format(value),
    date: (value, formatOptions) => new Intl.DateTimeFormat(i18n.tag, formatOptions).format(value),
  };
  return i18n;
}
