import { resources, type Messages } from "@otuken/i18n";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@otuken/shared";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: Messages };
  }
}

const STORAGE_KEY = "otuken.locale";

function readStoredLocale(): Locale | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Turkish is the product default. Before sign-in the last language chosen on
 * this device is used; after sign-in the user's saved preference wins.
 */
export const initialLocale: Locale = readStoredLocale() ?? DEFAULT_LOCALE;

void i18next.use(initReactI18next).init({
  resources: {
    tr: { translation: resources.tr },
    en: { translation: resources.en },
  },
  lng: initialLocale,
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnNull: false,
});

document.documentElement.lang = initialLocale;

export function applyLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Storage may be unavailable (private mode); the choice still applies to this tab.
  }
  document.documentElement.lang = locale;
  if (i18next.language !== locale) void i18next.changeLanguage(locale);
}

export { i18next };
