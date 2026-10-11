import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "../stores/session-store.ts";
import { LogoMark } from "./brand/logo.tsx";
import { Wallpaper } from "./brand/wallpaper.tsx";
import { LanguageSwitcher } from "./language-switcher.tsx";
import { Alert } from "./ui/alert.tsx";

/** Shared frame for pre-authentication screens (setup, login). */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const bootstrap = useSessionStore((state) => state.bootstrap);
  const insecure = bootstrap ? !bootstrap.transport.secure && !bootstrap.transport.loopback : false;

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Wallpaper />
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>
      <main className="everyos-enter flex w-full max-w-[440px] flex-col gap-5">
        <div className="flex flex-col items-center gap-3 text-center">
          <LogoMark
            className="size-16 drop-shadow-[0_8px_30px_rgb(125_211_252/0.35)]"
            title={t("brand.name")}
          />
          <div className="flex flex-col gap-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle ? <p className="text-sm leading-relaxed text-fg-muted">{subtitle}</p> : null}
          </div>
        </div>
        {insecure ? (
          <Alert tone="warning" title={t("transport.insecureTitle")}>
            {t("transport.insecureBody")}
          </Alert>
        ) : null}
        <section className="glass rounded-everyos-lg p-6 sm:p-7">{children}</section>
        <footer className="text-center text-xs text-fg-subtle">
          {t("brand.tagline")}
          {bootstrap ? (
            <span className="block pt-1 opacity-75">
              {t("common.version", { version: bootstrap.version })}
            </span>
          ) : null}
        </footer>
      </main>
    </div>
  );
}
