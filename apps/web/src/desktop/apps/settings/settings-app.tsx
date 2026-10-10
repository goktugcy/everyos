import {
  Info,
  LayoutDashboard,
  Palette,
  PanelsTopLeft,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/cn.ts";
import { SETTINGS_SECTIONS, type SettingsSection } from "../../commands.tsx";
import { AppLoading } from "../../windows/app-content.tsx";
import { useAppStateField } from "../app-context.ts";

const SECTIONS: Record<SettingsSection, { icon: LucideIcon; component: ReturnType<typeof lazy> }> =
  {
    appearance: { icon: Palette, component: lazy(() => import("./appearance-section.tsx")) },
    desktop: { icon: LayoutDashboard, component: lazy(() => import("./desktop-section.tsx")) },
    widgets: { icon: PanelsTopLeft, component: lazy(() => import("./widgets-section.tsx")) },
    account: { icon: UserRound, component: lazy(() => import("./account-section.tsx")) },
    security: { icon: ShieldCheck, component: lazy(() => import("./security-section.tsx")) },
    about: { icon: Info, component: lazy(() => import("./about-section.tsx")) },
  };

/** Settings app; the open section is part of the window state, so it survives reloads. */
export default function SettingsApp() {
  const { t } = useTranslation();
  const [section, setSection] = useAppStateField("section", SETTINGS_SECTIONS, "appearance");
  const Section = SECTIONS[section].component;

  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label={t("apps.settings")}
        className="w-52 shrink-0 overflow-y-auto border-r border-line p-2.5 max-sm:w-16"
      >
        <ul className="flex flex-col gap-0.5">
          {SETTINGS_SECTIONS.map((id) => {
            const Icon = SECTIONS[id].icon;
            const active = id === section;
            return (
              <li key={id}>
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => setSection(id)}
                  className={cn(
                    "flex h-9 w-full items-center gap-2.5 rounded-otk-md px-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    active
                      ? "bg-[rgb(var(--otk-accent)/0.2)] font-medium text-fg"
                      : "text-fg-muted hover:bg-hover/8 hover:text-fg",
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="truncate max-sm:sr-only">{t(`settings.sections.${id}`)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto" data-testid={`settings-${section}`}>
        <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
          <h2 className="text-xl font-semibold tracking-tight">
            {t(`settings.sections.${section}`)}
          </h2>
          <Suspense fallback={<AppLoading />}>
            <Section />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
