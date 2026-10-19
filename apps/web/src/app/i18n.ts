import { en, loadMessages, type Messages } from "@everyos/i18n/client";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@everyos/shared";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: Messages };
  }
}

const STORAGE_KEY = "everyos.locale";

function readStoredLocale(): Locale | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("otuken.locale");
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * English is the product default. Before sign-in the last language chosen on
 * this device is used; after sign-in the user's saved preference wins.
 */
export const initialLocale: Locale = readStoredLocale() ?? DEFAULT_LOCALE;

const initialized = i18next.use(initReactI18next).init({
  // English ships with the page (it is also the fallback); other languages load on demand.
  resources: { en: { translation: en } },
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnNull: false,
});

const loading = new Map<Locale, Promise<void>>();
let request = 0;

async function load(locale: Locale): Promise<void> {
  await initialized;
  if (i18next.hasResourceBundle(locale, "translation")) return;
  let pending = loading.get(locale);
  if (!pending) {
    pending = loadMessages[locale]()
      .then((messages) => {
        i18next.addResourceBundle(locale, "translation", messages, true, true);
      })
      .finally(() => loading.delete(locale));
    loading.set(locale, pending);
  }
  await pending;
}

async function show(locale: Locale): Promise<void> {
  const current = ++request;
  try {
    await load(locale);
    // A slow download must not replace a language the user chose more recently.
    if (current !== request) return;
    if (i18next.language !== locale) await i18next.changeLanguage(locale);
    if (current !== request) return;
    document.documentElement.lang = locale;
  } catch {
    // The language could not be loaded (e.g. offline after an update); stay on the current one.
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Storage may be unavailable (private mode); the choice still applies to this tab.
  }
}

/** Resolves once the first language is ready, so the first screen never flashes in English. */
export const i18nReady: Promise<void> = show(initialLocale);

export function applyLocale(locale: Locale): void {
  void show(locale);
}

export { i18next };
