import { useTranslation } from "react-i18next";
import { useAppHost } from "../apps/app-context.ts";
import { AppFrame } from "./app-frame.tsx";
import { useDesktopApps } from "./store.ts";

/** Window content of an installed desktop app. */
export default function DesktopAppWindow({ appId }: { appId?: string }) {
  const { t } = useTranslation();
  const host = useAppHost();
  const app = useDesktopApps((state) =>
    state.apps.find((entry) => entry.appId === appId && entry.state === "active"),
  );
  if (!app)
    return (
      <div role="alert" className="grid h-full place-items-center p-6 text-center">
        <p className="max-w-sm text-sm text-fg-muted">{t("desktopApps.frame.unavailable")}</p>
      </div>
    );
  return <AppFrame key={app.runtimeUrl} app={app} kind="window" entry={app.entry} host={host} />;
}
