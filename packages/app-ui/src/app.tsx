import {
  BridgeError,
  createApp,
  createI18n,
  packageMessages,
  type EveryOSApp,
  type I18n,
  type Messages,
} from "@everyos/app-sdk";
import {
  createContext,
  StrictMode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/states.tsx";
import { ToastHost } from "./components/toast.tsx";
import { UI_MESSAGES } from "./messages.ts";

/** The ten languages of EveryOS; official apps ship all of them. */
export const EVERYOS_LOCALES = [
  "en",
  "tr",
  "de",
  "es",
  "fr",
  "it",
  "ja",
  "ko",
  "ru",
  "zh",
] as const;

interface Context {
  app: EveryOSApp;
  i18n: I18n;
  /** Changes when the language changes (re-renders whatever reads texts). */
  locale: string;
}

const AppContext = createContext<Context | null>(null);

function useContextValue(): Context {
  const value = useContext(AppContext);
  if (!value) throw new Error("Use @everyos/app-ui inside boot() or <AppProvider>");
  return value;
}

/** The connection to EveryOS (`createApp()`), for the components of an app. */
export function useApp(): EveryOSApp {
  return useContextValue().app;
}

export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The app's texts in the person's language; re-renders when it changes. */
export function useT(): Translate {
  const { i18n, locale } = useContextValue();
  // `locale` makes a new function per language, so memoized children update too.
  return useCallback<Translate>((key, values) => i18n.t(key, values), [i18n, locale]);
}

export function useI18n(): I18n {
  return useContextValue().i18n;
}

function deepMerge(base: Messages, extra: Messages): Messages {
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] =
      typeof value === "object" && typeof current === "object" ? deepMerge(current, value) : value;
  }
  return out;
}

/** The app's own texts (its package's locale files), with the kit's `ui.*` texts under them. */
export async function createAppI18n(
  app: EveryOSApp,
  supported: readonly string[] = EVERYOS_LOCALES,
  load: (locale: string) => Promise<Messages> | Messages = packageMessages(),
): Promise<I18n> {
  return createI18n({
    locale: app.locale.current,
    supported,
    load: async (locale) =>
      deepMerge({ ui: UI_MESSAGES[locale] ?? UI_MESSAGES.en! }, await load(locale)),
  });
}

/** Provides the app and its texts, and follows language changes. */
export function AppProvider({
  app,
  i18n,
  children,
}: {
  app: EveryOSApp;
  i18n: I18n;
  children: ReactNode;
}) {
  const [locale, setLocale] = useState(i18n.locale);
  useEffect(
    () =>
      app.locale.onChange((next) => {
        void i18n.setLocale(next).then(() => setLocale(i18n.locale));
      }),
    [app, i18n],
  );
  const value = useMemo(() => ({ app, i18n, locale }), [app, i18n, locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export interface BootedApp {
  app: EveryOSApp;
  /** Removes the interface (tests start apps several times in one page). */
  unmount(): void;
}

/**
 * Starts an official app: connects to EveryOS, applies the theme, loads the texts, renders `Root`
 * into `#app` with the kit's providers and tells EveryOS the app is ready.
 */
export async function boot(
  Root: ComponentType,
  options: { locales?: readonly string[]; container?: HTMLElement } = {},
): Promise<BootedApp | null> {
  const container = options.container ?? document.getElementById("app");
  if (!container) throw new Error("No #app element");
  let app: EveryOSApp;
  try {
    app = await createApp();
  } catch (error) {
    container.textContent =
      error instanceof BridgeError && error.code === "EVERYOS_CLOSED"
        ? "This is an EveryOS app: install it on EveryOS to use it."
        : `EveryOS did not connect (${error instanceof Error ? error.message : String(error)}).`;
    return null;
  }
  app.theme.apply();
  const i18n = await createAppI18n(app, options.locales);
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <AppProvider app={app} i18n={i18n}>
        <ToastHost>
          <ErrorBoundary>
            <Root />
          </ErrorBoundary>
        </ToastHost>
      </AppProvider>
    </StrictMode>,
  );
  await app.lifecycle.ready();
  return { app, unmount: () => root.unmount() };
}
