import { useTranslation } from "react-i18next";
import { ArrowUpRight, Coffee, Globe2 } from "lucide-react";
import { SelfUpdatePanel } from "../../../features/updates/self-update-panel.tsx";
import { useSessionStore } from "../../../stores/session-store.ts";

const PROJECT_LINKS = [
  { key: "github", href: "https://github.com/goktugcy/everyos", icon: null },
  { key: "website", href: "https://everyos.net", icon: Globe2 },
  { key: "support", href: "https://buymeacoffee.com/goktugcy", icon: Coffee },
] as const;

export default function AboutSection() {
  const { t } = useTranslation();
  const bootstrap = useSessionStore((state) => state.bootstrap);
  const rows: Array<[string, string]> = bootstrap
    ? [
        [t("settings.about.mode"), t(`settings.about.modes.${bootstrap.mode}`)],
        [
          t("settings.about.connection"),
          bootstrap.transport.secure ? t("settings.about.secure") : t("settings.about.insecure"),
        ],
      ]
    : [];
  return (
    <div className="@container flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3 pb-4 text-center">
        <div className="-my-4 w-80 max-w-full">
          <img
            src="/everyos-white.png"
            alt={t("brand.name")}
            width={2172}
            height={724}
            draggable={false}
            className="h-auto w-full [[data-scheme=light]_&]:hidden"
          />
          <img
            src="/everyos.png"
            alt={t("brand.name")}
            width={2172}
            height={724}
            draggable={false}
            className="hidden h-auto w-full [[data-scheme=light]_&]:block"
          />
        </div>
        <p className="text-sm text-fg-muted">{t("brand.tagline")}</p>
        <p className="max-w-md text-sm leading-relaxed text-fg-muted">
          {t("settings.about.description")}
        </p>
        <dl className="glass-inset grid w-full max-w-sm grid-cols-2 gap-x-4 gap-y-2 rounded-everyos-lg p-4 text-left text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-fg-muted">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <nav
        aria-label={t("settings.about.links.title")}
        className="grid gap-3 @min-[560px]:grid-cols-3"
      >
        {PROJECT_LINKS.map(({ key, href, icon: Icon }) => (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="glass-inset group flex min-w-0 items-start gap-3 rounded-everyos-lg p-4 outline-none transition-colors hover:bg-accent/8 focus-visible:ring-2 focus-visible:ring-accent"
          >
            {Icon ? (
              <Icon className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
            ) : (
              <span
                aria-hidden
                className="mt-0.5 size-5 shrink-0 bg-current text-fg"
                style={{
                  maskImage: "url('/brand-icons/github.svg')",
                  WebkitMaskImage: "url('/brand-icons/github.svg')",
                  maskSize: "contain",
                  maskPosition: "center",
                  maskRepeat: "no-repeat",
                }}
              />
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">
                {t(`settings.about.links.${key}`)}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-fg-muted">
                {t(`settings.about.links.${key}Hint`)}
              </span>
            </span>
            <ArrowUpRight
              className="size-3.5 shrink-0 text-fg-subtle transition-colors group-hover:text-accent"
              aria-hidden
            />
          </a>
        ))}
      </nav>
      <div className="glass-inset rounded-everyos-lg">
        <SelfUpdatePanel />
      </div>
    </div>
  );
}
