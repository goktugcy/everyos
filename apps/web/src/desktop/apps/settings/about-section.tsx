import { useTranslation } from "react-i18next";
import { LogoMark } from "../../../components/brand/logo.tsx";
import { useSessionStore } from "../../../stores/session-store.ts";

export default function AboutSection() {
  const { t } = useTranslation();
  const bootstrap = useSessionStore((state) => state.bootstrap);
  const rows: Array<[string, string]> = bootstrap
    ? [
        [t("settings.about.version"), bootstrap.version],
        [t("settings.about.mode"), t(`settings.about.modes.${bootstrap.mode}`)],
        [
          t("settings.about.connection"),
          bootstrap.transport.secure ? t("settings.about.secure") : t("settings.about.insecure"),
        ],
      ]
    : [];
  return (
    <div className="flex flex-col items-center gap-5 py-4 text-center">
      <LogoMark className="size-20" />
      <div>
        <p className="text-2xl font-semibold">{t("brand.name")}</p>
        <p className="text-sm text-fg-muted">{t("brand.tagline")}</p>
      </div>
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
  );
}
