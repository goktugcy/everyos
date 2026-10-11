import type { BackupOverview, BackupView } from "@everyos/shared";
import {
  CircleCheck,
  Download,
  Loader2,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api, uploadWithProgress } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes, formatDateTime, formatRelative } from "../../../lib/format.ts";
import { useHasPermission } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { localized } from "../store/parts.tsx";
import { LoadingBlock, ResourceError } from "../system/parts.tsx";
import { CreateDialog, DownloadDialog, RestoreDialog, SettingsDialog } from "./dialogs.tsx";
import { contentLabels, jobError, stageText, verificationText } from "./lib.ts";
import { filesChanged } from "../files/lib.ts";

type Open =
  | { kind: "create" }
  | { kind: "settings" }
  | { kind: "download"; backup: BackupView }
  | { kind: "restore"; backup: BackupView };

/** Backups: manual and scheduled backups, verification, download and restore. */
export default function BackupsApp() {
  const { t, i18n } = useTranslation();
  const canRestore = useHasPermission("backups:restore");
  const [revision, setRevision] = useState(0);
  const [running, setRunning] = useState(false);
  const overview = useApiResource<BackupOverview>("/backups", running ? 1_000 : 10_000, revision);
  const data = overview.data;
  const jobRunning = Boolean(data?.job);
  if (jobRunning !== running) setRunning(jobRunning);
  const [open, setOpen] = useState<Open | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ loaded: number; total: number } | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const reload = () => setRevision((n) => n + 1);
  const appName = (id: string) => {
    const app = data?.apps.find((entry) => entry.id === id);
    return app ? localized(app.name, i18n.language) || id : id;
  };

  const act = async (key: string, run: () => Promise<unknown>) => {
    setError(null);
    setBusy(key);
    try {
      await run();
      reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };

  const uploadFile = async (file: File) => {
    setError(null);
    setUpload({ loaded: 0, total: file.size });
    try {
      await uploadWithProgress("/backups/upload", file, (loaded, total) =>
        setUpload({ loaded, total }),
      );
      reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setUpload(null);
    }
  };

  const last = data?.lastJob;
  useEffect(() => {
    if (last?.kind === "restore" && last.status === "succeeded") filesChanged();
  }, [last?.id, last?.kind, last?.status]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="backups-app">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <p className="max-w-xl text-xs text-fg-muted">{t("backups.intro")}</p>
        <div className="flex gap-2">
          {canRestore ? (
            <>
              <input
                ref={uploadInput}
                type="file"
                accept=".tar,application/x-tar"
                className="hidden"
                data-testid="backup-upload-input"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void uploadFile(file);
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={upload !== null}
                onClick={() => uploadInput.current?.click()}
              >
                <Upload className="size-4" aria-hidden />
                {t("backups.upload")}
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={!data}
            onClick={() => setOpen({ kind: "settings" })}
          >
            <Settings2 className="size-4" aria-hidden />
            {t("backups.settings")}
          </Button>
          <Button
            size="sm"
            disabled={!data || jobRunning}
            onClick={() => setOpen({ kind: "create" })}
          >
            <Plus className="size-4" aria-hidden />
            {t("backups.create")}
          </Button>
        </div>
      </div>

      {data ? (
        <p className="shrink-0 px-4 pt-2 text-xs text-fg-muted" data-testid="backup-storage">
          {t("backups.storage", {
            location: data.storage.location,
            used: formatBytes(data.storage.usedBytes, i18n.language),
            free:
              data.storage.freeBytes === null
                ? "—"
                : formatBytes(data.storage.freeBytes, i18n.language),
            reserve: formatBytes(data.storage.reserveBytes, i18n.language),
          })}
        </p>
      ) : null}

      <div className="flex shrink-0 flex-col gap-2 px-4 pt-3 empty:hidden">
        {data?.job ? (
          <Alert tone="info">
            <div
              className="flex flex-wrap items-center justify-between gap-3"
              data-testid="backup-job"
            >
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {t(data.job.kind === "restore" ? "backups.restoring" : "backups.creating")} —{" "}
                {stageText(t, data.job, appName)}
                {data.job.bytes > 0 ? ` · ${formatBytes(data.job.bytes, i18n.language)}` : ""}
              </span>
              <Button
                size="sm"
                variant="ghost"
                loading={busy === "cancel"}
                onClick={() =>
                  void act("cancel", () => api("/backups/cancel", { method: "POST", body: {} }))
                }
              >
                <Square className="size-3.5" aria-hidden />
                {t("common.cancel")}
              </Button>
            </div>
          </Alert>
        ) : null}
        {!data?.job && last && last.status !== "succeeded" ? (
          <Alert tone={last.status === "cancelled" ? "warning" : "danger"}>
            <span data-testid="backup-last-error">
              {t(last.kind === "restore" ? "backups.restoreFailed" : "backups.createFailed", {
                reason:
                  last.status === "cancelled" ? t("backups.cancelled") : jobError(t, last.error),
              })}
            </span>
          </Alert>
        ) : null}
        {!data?.job && last?.kind === "restore" && last.status === "succeeded" ? (
          <Alert tone={last.restart ? "warning" : "success"}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span data-testid="backup-restored">
                {last.restart === "automatic"
                  ? t("backups.restartAutomatic")
                  : last.restart === "manual"
                    ? t("backups.restartManual")
                    : t("backups.restored")}
              </span>
              {last.restart === null ? (
                <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
                  {t("backups.reloadPage")}
                </Button>
              ) : null}
            </div>
          </Alert>
        ) : null}
        {upload ? (
          <Alert tone="info">
            {t("backups.uploading", {
              percent: upload.total ? Math.round((upload.loaded / upload.total) * 100) : 0,
            })}
          </Alert>
        ) : null}
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto pt-2">
        <ResourceError error={overview.error} />
        {overview.loading ? <LoadingBlock /> : null}
        {data?.backups.length === 0 ? (
          <p className="p-10 text-center text-sm text-fg-muted">{t("backups.empty")}</p>
        ) : null}
        {data && data.backups.length > 0 ? (
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="sticky top-0 z-10 bg-[rgb(var(--everyos-surface)/0.95)] text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-4 py-1.5 font-semibold">
                  {t("backups.columns.created")}
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  {t("backups.columns.contents")}
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  {t("backups.columns.size")}
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  {t("backups.columns.check")}
                </th>
                <th scope="col" className="px-2 py-1.5">
                  <span className="sr-only">{t("backups.columns.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.backups.map((backup) => (
                <tr key={backup.id} className="border-t border-line" data-testid="backup-row">
                  <td className="px-4 py-2">
                    <div className="flex flex-col">
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        {backup.pinned ? (
                          <Pin className="size-3.5 text-accent" aria-label={t("backups.pinned")} />
                        ) : null}
                        {formatDateTime(backup.createdAt, i18n.language)}
                      </span>
                      <span className="text-xs text-fg-muted">
                        {t(`backups.triggers.${backup.trigger}`)}
                        {backup.uploaded ? ` · ${t("backups.uploaded")}` : ""}
                        {backup.createdBy ? ` · ${backup.createdBy}` : ""}
                        {` · ${formatRelative(backup.createdAt, i18n.language)}`}
                      </span>
                      {backup.note && backup.trigger !== "pre-restore" ? (
                        <span className="text-xs">{backup.note}</span>
                      ) : null}
                      {!backup.sameKey ? (
                        <span className="text-xs text-warning">{t("backups.otherKey")}</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-xs">{contentLabels(t, backup).join(" · ")}</td>
                  <td className="px-2 py-2 text-xs">{formatBytes(backup.size, i18n.language)}</td>
                  <td className="px-2 py-2 text-xs">
                    {backup.verification === null ? (
                      <span className="text-fg-subtle">—</span>
                    ) : backup.verification.ok ? (
                      <span
                        className="inline-flex items-center gap-1 text-success"
                        title={formatDateTime(backup.verification.at, i18n.language)}
                      >
                        <CircleCheck className="size-3.5" aria-hidden />
                        {t("backups.ok")}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-danger">
                        <TriangleAlert className="size-3.5" aria-hidden />
                        {verificationText(t, backup.verification.error)}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("backups.verify")}
                        title={t("backups.verify")}
                        loading={busy === `verify:${backup.id}`}
                        onClick={() =>
                          void act(`verify:${backup.id}`, () =>
                            api(`/backups/${backup.id}/verify`, { method: "POST", body: {} }),
                          )
                        }
                      >
                        <ShieldCheck className="size-4" aria-hidden />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={backup.pinned ? t("backups.unpin") : t("backups.pin")}
                        title={backup.pinned ? t("backups.unpin") : t("backups.pin")}
                        onClick={() =>
                          void act(`pin:${backup.id}`, () =>
                            api(`/backups/${backup.id}/pin`, {
                              method: "PUT",
                              body: { pinned: !backup.pinned },
                            }),
                          )
                        }
                      >
                        {backup.pinned ? (
                          <PinOff className="size-4" aria-hidden />
                        ) : (
                          <Pin className="size-4" aria-hidden />
                        )}
                      </Button>
                      {canRestore ? (
                        <>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t("backups.download")}
                            title={t("backups.download")}
                            onClick={() => setOpen({ kind: "download", backup })}
                          >
                            <Download className="size-4" aria-hidden />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={jobRunning}
                            onClick={() => setOpen({ kind: "restore", backup })}
                          >
                            <RotateCcw className="size-3.5" aria-hidden />
                            {t("backups.restore")}
                          </Button>
                        </>
                      ) : null}
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("common.delete")}
                        title={t("common.delete")}
                        onClick={async () => {
                          const ok = await requestConfirm({
                            title: t("backups.deleteTitle"),
                            body: t("backups.deleteBody", {
                              date: formatDateTime(backup.createdAt, i18n.language),
                            }),
                            confirmLabel: t("common.delete"),
                            danger: true,
                          });
                          if (ok)
                            await act(`delete:${backup.id}`, () =>
                              api(`/backups/${backup.id}`, { method: "DELETE" }),
                            );
                        }}
                      >
                        <Trash2 className="size-4 text-danger" aria-hidden />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      {open?.kind === "create" && data ? (
        <CreateDialog
          apps={data.apps}
          defaults={data.settings.appData}
          onClose={() => setOpen(null)}
          onStarted={reload}
        />
      ) : null}
      {open?.kind === "settings" && data ? (
        <SettingsDialog
          settings={data.settings}
          apps={data.apps}
          onClose={() => setOpen(null)}
          onSaved={reload}
        />
      ) : null}
      {open?.kind === "download" ? (
        <DownloadDialog backup={open.backup} onClose={() => setOpen(null)} />
      ) : null}
      {open?.kind === "restore" && data ? (
        <RestoreDialog
          backup={open.backup}
          supervised={data.supervised}
          onClose={() => setOpen(null)}
          onStarted={reload}
        />
      ) : null}
    </div>
  );
}
