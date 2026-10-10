import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LogoMark } from "../../components/brand/logo.tsx";
import { Wallpaper } from "../../components/brand/wallpaper.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { ApiRequestError } from "../../lib/api.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { AccountSecurityDialog } from "../account/account-security-dialog.tsx";
import { SystemCard } from "../system/system-card.tsx";
import { useSystemInfo } from "../system/use-system-info.ts";
import { TopBar } from "./top-bar.tsx";

/**
 * Phase 1 authenticated shell: menu bar, real host information and account
 * security. Phase 2 replaces the centered content with the desktop
 * (windows, dock, widgets) while keeping the menu bar.
 */
export function FoundationShell() {
  const { t } = useTranslation();
  const session = useSessionStore((state) => state.session);
  const bootstrap = useSessionStore((state) => state.bootstrap);
  const system = useSystemInfo();
  const [accountOpen, setAccountOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  const agentConnected = system.info
    ? true
    : system.error instanceof ApiRequestError &&
        ["AGENT_UNAVAILABLE", "AGENT_TIMEOUT"].includes(system.error.code)
      ? false
      : null;
  const insecure = bootstrap ? !bootstrap.transport.secure && !bootstrap.transport.loopback : false;

  return (
    <div className="relative min-h-dvh">
      <Wallpaper />
      <TopBar
        agentConnected={agentConnected}
        insecure={insecure}
        onOpenAccount={() => setAccountOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
      />
      <main className="otk-enter mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-16 pt-20">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            {t("shell.welcome", { name: session?.user.displayName ?? "" })}
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-fg-muted">
            {t("shell.foundationNotice")}
          </p>
        </div>
        {insecure ? (
          <Alert tone="warning" title={t("transport.insecureTitle")}>
            {t("transport.insecureBody")}
          </Alert>
        ) : null}
        <SystemCard state={system} />
      </main>

      <AccountSecurityDialog open={accountOpen} onOpenChange={setAccountOpen} />
      <Dialog open={aboutOpen} onOpenChange={setAboutOpen} title={t("shell.menu.about")}>
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <LogoMark className="size-16" />
          <div>
            <p className="text-lg font-semibold">Otuken</p>
            {bootstrap ? (
              <p className="text-sm text-fg-subtle">
                {t("common.version", { version: bootstrap.version })}
              </p>
            ) : null}
          </div>
          <p className="text-sm leading-relaxed text-fg-muted">{t("shell.aboutBody")}</p>
          <p className="text-xs text-fg-subtle">{t("brand.tagline")}</p>
        </div>
      </Dialog>
    </div>
  );
}
