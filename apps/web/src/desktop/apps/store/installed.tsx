import type { AppAction, AppJobView, InstalledAppView } from "@everyos/shared";
import { PanelsTopLeft, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { api } from "../../../lib/api.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { localized } from "./parts.tsx";
import { offerFor } from "../../widgets/offer.tsx";
import { widgetUi } from "../../widgets/ui-store.ts";
import { appLaunchLinks } from "./launch-links.ts";

export function InstalledCard({
  app,
  onJob,
  onChanged,
}: {
  app: InstalledAppView;
  onJob: (job: AppJobView) => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const canManage = usePermissions().includes("apps:manage");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [dismissedJob, setDismissedJob] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const errorId = `${app.lastJob?.id ?? ""}:${app.lastError ?? ""}`;
  const launchLinks = appLaunchLinks(app, window.location.hostname);
  const act = async (action: Exclude<AppAction, "install">) => {
    if (
      action !== "start" &&
      !(await requestConfirm({
        title: t("appStore.confirmTitle", {
          name: localized(app.name, i18n.language),
          action: t(`appStore.actions.${action}`),
        }),
        body: t(
          action === "remove"
            ? "appStore.removeBody"
            : action === "update"
              ? "appStore.updateBody"
              : "appStore.confirmBody",
        ),
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
    <article
      className="glass-inset flex flex-col gap-3 rounded-everyos-md p-4"
      data-app-installation={app.id}
    >
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="font-semibold">{localized(app.name, i18n.language)}</h3>
        <span className="flex items-center gap-2 text-xs">
          {t(`appStore.states.${app.state}`)}
          <SimulatedBadge source={app.source} />
        </span>
      </div>
      <p className="break-all font-mono text-xs text-fg-subtle">{app.project}</p>
      {app.lastJob && dismissedJob !== app.lastJob.id ? (
        <div className="flex items-start gap-2 text-xs text-fg-muted" data-testid="app-last-job">
          <p>
            {t("appStore.progress", {
              action: t(`appStore.actions.${app.lastJob.action}`),
              stage: t(`appStore.stages.${app.lastJob.stage}`),
            })}
            {app.lastJob.stage === "failed"
              ? ` · ${t(`appStore.rollback.${app.lastJob.rollback}`)}`
              : ""}
          </p>
          <button
            type="button"
            aria-label={t("notifications.dismiss")}
            className="ml-auto grid size-6 shrink-0 place-items-center rounded-everyos-sm hover:bg-hover/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => setDismissedJob(app.lastJob!.id)}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}
      {app.images?.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-fg-muted">
            {t(
              app.images.some((image) => image.digest !== null)
                ? "appStore.imageDigests"
                : "appStore.imageReferences",
            )}
          </summary>
          <ul className="mt-2 break-all font-mono">
            {app.images.map((image) => (
              <li key={`${image.reference}:${image.platform}`}>
                {image.reference} · {image.platform}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {app.source === "host" && app.state === "running" ? (
        <div className="flex flex-wrap gap-3">
          {launchLinks.map((port) => (
            <a
              key={port.port}
              href={port.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-accent underline"
            >
              {t("appStore.launch", { port: port.port })}
            </a>
          ))}
          {app.ports.length ? (
            <p className="w-full text-xs text-fg-muted">{t("appStore.configureAfterInstall")}</p>
          ) : null}
        </div>
      ) : null}
      {app.lastError && dismissedError !== errorId ? (
        <Alert tone="warning" onDismiss={() => setDismissedError(errorId)}>
          {t("appStore.failed", { reason: app.lastError })}
        </Alert>
      ) : null}
      <ResourceError error={error} onDismiss={() => setError(null)} />
      <div>
        <Button variant="ghost" size="sm" onClick={() => widgetUi.offer(offerFor(app))}>
          <PanelsTopLeft className="size-4" aria-hidden />
          {t("widgets.title")}
        </Button>
      </div>
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
          {app.lastError ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={pending || app.state === "busy"}
              onClick={() => void act("retry")}
            >
              {t("appStore.actions.retry")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await api(`/apps/${app.id}/reconcile`, { method: "POST", body: {} });
                onChanged();
              } catch (caught) {
                setError(caught);
              } finally {
                setPending(false);
              }
            }}
          >
            {t("appStore.reconcile")}
          </Button>
        </div>
      ) : null}
    </article>
  );
}
