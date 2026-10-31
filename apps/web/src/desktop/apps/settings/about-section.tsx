import { useTranslation } from "react-i18next";
import { SelfUpdatePanel } from "../../../features/updates/self-update-panel.tsx";
import { useSessionStore } from "../../../stores/session-store.ts";

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
    <div className="flex flex-col gap-6">
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
      <div className="glass-inset rounded-everyos-lg">
        <SelfUpdatePanel />
      </div>
    </div>
  );
}
