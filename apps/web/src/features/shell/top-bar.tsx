import type { Locale, PublicUser } from "@otuken/shared";
import { Info, LogOut, ShieldAlert, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LogoMark } from "../../components/brand/logo.tsx";
import { LanguageSwitcher } from "../../components/language-switcher.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { api } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { Clock } from "./clock.tsx";

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toLocaleUpperCase())
      .join("") || "?"
  );
}

export function TopBar({
  agentConnected,
  insecure,
  onOpenAccount,
  onOpenAbout,
}: {
  agentConnected: boolean | null;
  insecure: boolean;
  onOpenAccount: () => void;
  onOpenAbout: () => void;
}) {
  const { t } = useTranslation();
  const user = useSessionStore((state) => state.session?.user);
  const updateUser = useSessionStore((state) => state.updateUser);
  const signOut = useSessionStore((state) => state.signOut);

  const persistLocale = (locale: Locale) => {
    void api<PublicUser>("/account", { method: "PATCH", body: { locale } }).then(
      updateUser,
      () => undefined,
    );
  };

  return (
    <header className="glass-strong fixed inset-x-0 top-0 z-30 flex h-10 items-center gap-2 rounded-none border-x-0 border-t-0 px-2 text-[0.8rem] pt-[env(safe-area-inset-top)]">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex h-8 items-center gap-2 rounded-otk-sm px-2 font-semibold hover:bg-white/8"
          aria-label={t("shell.menu.label")}
        >
          <LogoMark className="size-5" />
          <span>Otuken</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem icon={<Info />} onSelect={onOpenAbout}>
            {t("shell.menu.about")}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<ShieldCheck />} onSelect={onOpenAccount}>
            {t("shell.menu.accountSecurity")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<LogOut />} onSelect={() => void signOut()}>
            {t("shell.menu.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex items-center gap-1.5">
        {insecure ? (
          <span
            className="flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-warning"
            title={t("transport.insecureBody")}
          >
            <ShieldAlert className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">{t("transport.insecureTitle")}</span>
          </span>
        ) : null}
        {agentConnected !== null ? (
          <span
            className="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-fg-muted"
            title={agentConnected ? t("agent.connected") : t("agent.unavailable")}
          >
            <span
              className={cn("size-2 rounded-full", agentConnected ? "bg-success" : "bg-danger")}
              aria-hidden
            />
            <span className="sr-only sm:not-sr-only">
              {agentConnected ? t("agent.connected") : t("agent.unavailable")}
            </span>
          </span>
        ) : null}
        <LanguageSwitcher compact onChange={persistLocale} />
        <span className="hidden px-1.5 text-fg-muted sm:inline">
          <Clock />
        </span>
        {user ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="grid size-7 place-items-center rounded-full bg-[linear-gradient(135deg,rgb(var(--otk-accent)),rgb(var(--otk-accent-strong)))] text-[0.7rem] font-bold text-accent-contrast"
              aria-label={t("shell.userMenu")}
            >
              {initials(user.displayName)}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                <span className="block text-sm font-semibold text-fg">{user.displayName}</span>
                <span className="block">
                  @{user.username} · {t(`roles.${user.role}`)}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<ShieldCheck />} onSelect={onOpenAccount}>
                {t("shell.menu.accountSecurity")}
              </DropdownMenuItem>
              <DropdownMenuItem icon={<LogOut />} onSelect={() => void signOut()}>
                {t("shell.menu.signOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </header>
  );
}
