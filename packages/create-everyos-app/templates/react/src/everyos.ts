import { createApp, createI18n } from "@everyos/app-sdk";
import { useEffect, useState } from "react";

/** The connection to EveryOS and the app's texts, shared by every component. */
export const app = await createApp();
app.theme.apply();
export const i18n = await createI18n({ locale: app.locale.current, supported: ["en", "tr"] });

/** Re-renders when the person changes the interface language. */
export function useLanguage(): string {
  const [locale, setLocale] = useState(i18n.locale);
  useEffect(
    () =>
      app.locale.onChange((next) => {
        void i18n.setLocale(next).then(() => setLocale(next));
      }),
    [],
  );
  return locale;
}
