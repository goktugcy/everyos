import type { AppAction, AppJobView, InstalledAppView } from "@otuken/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { api } from "../../../lib/api.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { localized } from "./parts.tsx";

export function InstalledCard({
  app,
  onJob,
}: {
  app: InstalledAppView;
  onJob: (job: AppJobView) => void;
}) {
  const { t, i18n } = useTranslation();
  const canManage = usePermissions().includes("apps:manage");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const act = async (action: Exclude<AppAction, "install">) => {
    if (
      action !== "start" &&
      !(await requestConfirm({
        title: t("appStore.confirmTitle", {
          name: localized(app.name, i18n.language),
          action: t(`appStore.actions.${action}`),
        }),
        body: t(action === "remove" ? "appStore.removeBody" : "appStore.confirmBody"),
        confirmLabel: t(`appStore.actions.${action}`),
        danger: action === "remove",
      }))
    )
      return;
    setPending(true);
    setError(null);
    try {
      onJob(
        await api<AppJobView>(`/apps/${app.id}/actions`, {
          method: "POST",
          body: { action, confirmId: app.id },
        }),
      );
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };
  return (
    <article className="glass-inset flex flex-col gap-3 rounded-otk-md p-4">
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="font-semibold">{localized(app.name, i18n.language)}</h3>
        <span className="flex items-center gap-2 text-xs">
          {t(`appStore.states.${app.state}`)}
          <SimulatedBadge source={app.source} />
        </span>
      </div>
      <p className="break-all font-mono text-xs text-fg-subtle">{app.project}</p>
      {app.lastError ? (
        <Alert tone="warning">{t("appStore.failed", { reason: app.lastError })}</Alert>
      ) : null}
      <ResourceError error={error} />
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {(["start", "stop", "restart", "update", "remove"] as const).map((action) => (
            <Button
              key={action}
              variant={action === "remove" ? "ghost" : "secondary"}
              size="sm"
              disabled={pending || app.state === "busy"}
              onClick={() => void act(action)}
            >
              {t(`appStore.actions.${action}`)}
            </Button>
          ))}
        </div>
      ) : null}
    </article>
  );
}
