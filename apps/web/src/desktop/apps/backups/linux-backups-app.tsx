import type {
  LinuxBackupArchive,
  LinuxBackupJob,
  LinuxBackupOverview,
  LinuxBackupPlan,
  LinuxBackupInstallation,
} from "@everyos/shared";
import {
  Archive,
  CalendarClock,
  CheckCircle2,
  FolderTree,
  HardDrive,
  LockKeyhole,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { PasswordField } from "../../../components/ui/field.tsx";
import { SudoUnlock } from "../../../features/account/sudo-unlock.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes, formatDateTime } from "../../../lib/format.ts";
import { LoadingBlock, ResourceError } from "../system/parts.tsx";
import { LinuxBackupInstall } from "./linux-backup-install.tsx";
import { LinuxPlanDialog } from "./linux-plan-dialog.tsx";

const titleKey = { create: "run", verify: "verify", restore: "restore", prune: "prune" } as const;
const statusKey = {
  running: "statusRunning",
  succeeded: "statusSucceeded",
  warning: "statusWarning",
  failed: "statusFailed",
  cancelled: "statusCancelled",
} as const;
const stageKey = {
  preparing: "stagePreparing",
  archiving: "stageArchiving",
  verifying: "stageVerifying",
  restoring: "stageRestoring",
  retention: "stageRetention",
  done: "stageDone",
} as const;
type Action = { plan: LinuxBackupPlan; kind: LinuxBackupJob["kind"]; archive: string | null };

function ActionDialog({
  action,
  onClose,
  onStarted,
}: {
  action: Action;
  onClose: () => void;
  onStarted: (job: LinuxBackupJob) => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={t(`linuxBackups.${titleKey[action.kind]}`)}
      description={action.plan.name}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          void api<LinuxBackupJob>(`/linux-backups/plans/${action.plan.id}/jobs`, {
            method: "POST",
            body: { kind: action.kind, archive: action.archive, password },
          })
            .then(
              (job) => {
                onStarted(job);
                onClose();
              },
              (caught: unknown) => setError(caught),
            )
            .finally(() => setBusy(false));
        }}
      >
        {action.archive ? (
          <p className="break-all font-mono text-xs text-fg-muted">{action.archive}</p>
        ) : null}
        <Alert tone={action.kind === "prune" ? "warning" : "info"}>
          {t(
            action.kind === "restore"
              ? "linuxBackups.recoveryHint"
              : action.kind === "prune"
                ? "linuxBackups.retentionHint"
                : "linuxBackups.liveWarning",
          )}
        </Alert>
        <PasswordField
          label={t("linuxBackups.password")}
          value={password}
          required
          autoComplete="current-password"
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
        {error ? (
          <>
            <Alert tone="danger">{errorMessage(t, error)}</Alert>
            <SudoUnlock error={error} />
          </>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={busy} disabled={!password}>
            {t("linuxBackups.actionConfirm")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Archives({
  plan,
  busy,
  revision,
  onAction,
}: {
  plan: LinuxBackupPlan;
  busy: boolean;
  revision: string;
  onAction: (value: Action) => void;
}) {
  const { t, i18n } = useTranslation();
  const resource = useApiResource<{ archives: LinuxBackupArchive[]; limit: number }>(
    busy ? null : `/linux-backups/plans/${plan.id}/archives`,
    null,
    revision,
  );
  return (
    <div className="border-t border-line p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-muted">
        {t("linuxBackups.archives")}
      </h3>
      {resource.error ? (
        <>
          <ResourceError error={resource.error} />
          <SudoUnlock error={resource.error} />
          <Button size="sm" variant="ghost" onClick={resource.reload}>
            {t("common.refresh")}
          </Button>
        </>
      ) : resource.loading ? (
        <LoadingBlock />
      ) : !resource.data?.archives.length ? (
        <p className="text-sm text-fg-subtle">{t("linuxBackups.noArchives")}</p>
      ) : (
        <div>
          {resource.data.archives.length >= resource.data.limit ? (
            <p className="mb-3 text-xs text-fg-muted">
              {t("linuxBackups.archiveLimit", { count: resource.data.limit })}
            </p>
          ) : null}
          <ul className="flex max-h-72 flex-col overflow-y-auto divide-y divide-line">
            {resource.data.archives.map((archive) => (
              <li
                key={archive.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div>
                  <p className="text-sm font-medium">
                    {formatDateTime(archive.createdAt, i18n.language)}
                  </p>
                  <p className="mt-1 break-all font-mono text-[10px] text-fg-subtle">
                    {archive.name}
                  </p>
                  <p
                    className={cn(
                      "mt-1 text-xs",
                      archive.verification === "verified" ? "text-success" : "text-warning",
                    )}
                  >
                    {t(
                      archive.verification === "verified"
                        ? "linuxBackups.verified"
                        : archive.verification === "warning"
                          ? "linuxBackups.statusWarning"
                          : "linuxBackups.unverified",
                    )}
                  </p>
                  {archive.scope ? (
                    <p className="mt-1 text-xs text-fg-muted">
                      {t("linuxBackups.scopeAtCapture")}: {t(`linuxBackups.${archive.scope}Title`)}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => onAction({ plan, kind: "verify", archive: archive.name })}
                  >
                    <ShieldCheck className="size-4" aria-hidden />
                    {t("linuxBackups.verify")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onAction({ plan, kind: "restore", archive: archive.name })}
                  >
                    <FolderTree className="size-4" aria-hidden />
                    {t("linuxBackups.restore")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function LinuxBackupsApp() {
  const { t, i18n } = useTranslation();
  const [revision, setRevision] = useState(0);
  const [polling, setPolling] = useState(false);
  const resource = useApiResource<LinuxBackupOverview>(
    "/linux-backups",
    polling ? 1000 : 10_000,
    revision,
  );
  const data = resource.data;
  const [pendingJob, setPendingJob] = useState<LinuxBackupJob | null>(null);
  const job =
    data?.job ??
    (pendingJob && !data?.history.some((j) => j.id === pendingJob.id) ? pendingJob : null);
  const [pendingInstallation, setPendingInstallation] = useState<LinuxBackupInstallation | null>(
    null,
  );
  const reportedInstallation = data?.installation;
  const installation =
    pendingInstallation &&
    reportedInstallation?.id !== pendingInstallation.id &&
    (!reportedInstallation || reportedInstallation.startedAt <= pendingInstallation.startedAt)
      ? pendingInstallation
      : (reportedInstallation ?? null);
  const busy = Boolean(job) || installation?.status === "running";
  if (polling !== busy) setPolling(busy);
  const [editing, setEditing] = useState<LinuxBackupPlan | "new" | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const reload = () => setRevision((v) => v + 1);
  const completed = data?.history[0];
  const latestId = completed?.id ?? "";
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="linux-backups-app">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line p-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-everyos-md bg-accent/10 text-accent">
            <HardDrive className="size-5" aria-hidden />
          </span>
          <div>
            <h2 className="text-sm font-semibold">{t("linuxBackups.title")}</h2>
            <p className="mt-1 text-xs text-fg-muted">{t("linuxBackups.intro")}</p>
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("common.refresh")}
            title={t("common.refresh")}
            onClick={reload}
          >
            <RefreshCw className="size-4" aria-hidden />
          </Button>
          <Button
            size="sm"
            disabled={
              !data?.capability.available ||
              !data.capability.targets.some((p) => p.available) ||
              busy
            }
            onClick={() => setEditing("new")}
          >
            <Plus className="size-4" aria-hidden />
            {t("linuxBackups.add")}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {error ? (
          <>
            <Alert tone="danger">{errorMessage(t, error)}</Alert>
            <SudoUnlock error={error} />
          </>
        ) : null}
        {resource.error ? <ResourceError error={resource.error} /> : null}
        {resource.loading ? <LoadingBlock /> : null}
        {data?.capability.source === "simulated" ? (
          <Alert tone="warning">{t("linuxBackups.simulated")}</Alert>
        ) : null}
        {data && !data.capability.available ? (
          <Alert tone="warning">
            <p className="font-medium">{t("linuxBackups.unavailable")}</p>
            <p className="mt-1 leading-relaxed">{t("linuxBackups.dependency")}</p>
          </Alert>
        ) : null}
        {data ? (
          <LinuxBackupInstall
            capability={data.capability}
            job={installation}
            onStarted={(value) => {
              setPendingInstallation(value);
              reload();
            }}
          />
        ) : null}
        {data?.capability.available && !data.capability.targets.some((p) => p.available) ? (
          <Alert tone="warning">{t("linuxBackups.noTargets")}</Alert>
        ) : null}
        {job ? (
          <section
            className="rounded-everyos-md border border-accent/35 bg-accent/5 p-4"
            aria-live="polite"
            data-testid="linux-backup-job"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">{t(`linuxBackups.${stageKey[job.stage]}`)}</p>
                {job.kind === "create" ? (
                  <p className="mt-2 text-xs tabular-nums text-fg-muted">
                    {t("linuxBackups.files", { count: job.files })} ·{" "}
                    {t("linuxBackups.written", { size: formatBytes(job.bytes, i18n.language) })} ·{" "}
                    {t("linuxBackups.stored", {
                      size: formatBytes(job.deduplicatedBytes, i18n.language),
                    })}
                  </p>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="sm"
                loading={cancelling}
                onClick={() => {
                  setCancelling(true);
                  void api("/linux-backups/cancel", { method: "POST", body: {} })
                    .then(reload, (caught: unknown) => setError(caught))
                    .finally(() => setCancelling(false));
                }}
              >
                <Square className="size-4" aria-hidden />
                {t("linuxBackups.cancel")}
              </Button>
            </div>
          </section>
        ) : null}
        {!job && completed ? (
          <Alert
            tone={
              completed.status === "succeeded"
                ? "success"
                : completed.status === "warning" || completed.status === "cancelled"
                  ? "warning"
                  : "danger"
            }
          >
            <p>
              {t(`linuxBackups.${titleKey[completed.kind]}`)} ·{" "}
              {t(`linuxBackups.${statusKey[completed.status]}`)}
            </p>
            {completed.status === "warning" ? (
              <p className="mt-1">{t("linuxBackups.warning")}</p>
            ) : completed.error && completed.status === "failed" ? (
              <p className="mt-1">{t("linuxBackups.jobError", { code: completed.error })}</p>
            ) : null}
            {completed.restorePath ? (
              <p className="mt-2 break-all font-mono text-xs" data-testid="linux-recovery-path">
                {t("linuxBackups.recoveryPath", { path: completed.restorePath })}
              </p>
            ) : null}
          </Alert>
        ) : null}
        {data && !data.plans.length ? (
          <div className="grid min-h-52 place-items-center rounded-everyos-md border border-dashed border-line p-8 text-center">
            <div>
              <Archive className="mx-auto mb-4 size-9 text-accent/70" aria-hidden />
              <h3 className="text-sm font-semibold">{t("linuxBackups.empty")}</h3>
              <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-fg-muted">
                {t("linuxBackups.emptyBody")}
              </p>
            </div>
          </div>
        ) : null}
        {data?.plans.map((plan) => {
          const target = data.capability.targets.find((p) => p.id === plan.targetId);
          const targetReady = target?.available && target.device === plan.targetDevice;
          const recent = data.history.find((j) => j.planId === plan.id && j.kind === "create");
          return (
            <section
              key={plan.id}
              className="shrink-0 overflow-hidden rounded-everyos-md border border-line"
              data-testid="linux-backup-plan"
              data-plan-id={plan.id}
            >
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words text-sm font-semibold">{plan.name}</h3>
                    <p className="mt-1 text-xs text-fg-muted">
                      {t(`linuxBackups.${plan.scope}Title`)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium",
                      plan.encryption === "none"
                        ? "bg-warning/10 text-warning"
                        : "bg-success/10 text-success",
                    )}
                  >
                    <LockKeyhole className="size-3" aria-hidden />
                    {t(
                      plan.encryption === "none" ? "linuxBackups.plain" : "linuxBackups.encrypted",
                    )}
                  </span>
                </div>
                <div className="my-4 grid gap-2 text-xs text-fg-muted">
                  <p className="flex items-center gap-2 break-all">
                    <HardDrive className="size-3.5 shrink-0" aria-hidden />
                    {target?.path ?? plan.targetPath}
                    {!targetReady ? (
                      <span className="text-warning">{t("linuxBackups.targetUnavailable")}</span>
                    ) : null}
                  </p>
                  <p className="flex items-center gap-2">
                    <CalendarClock className="size-3.5 shrink-0" aria-hidden />
                    {t("linuxBackups.next")}:{" "}
                    {plan.nextRunAt
                      ? formatDateTime(plan.nextRunAt, i18n.language)
                      : t("linuxBackups.paused")}
                  </p>
                  {recent ? (
                    <p className="flex items-center gap-2">
                      {recent.status === "succeeded" ? (
                        <CheckCircle2 className="size-3.5 text-success" aria-hidden />
                      ) : (
                        <TriangleAlert className="size-3.5 text-warning" aria-hidden />
                      )}
                      {t(`linuxBackups.${statusKey[recent.status]}`)} ·{" "}
                      {formatDateTime(recent.startedAt, i18n.language)}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    disabled={busy || !data.capability.available || !targetReady}
                    onClick={() => setAction({ plan, kind: "create", archive: null })}
                  >
                    <Play className="size-3.5" aria-hidden />
                    {t("linuxBackups.run")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setExpanded(expanded === plan.id ? null : plan.id)}
                    aria-expanded={expanded === plan.id}
                  >
                    <Archive className="size-4" aria-hidden />
                    {t("linuxBackups.archives")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setEditing(plan)}
                  >
                    <Settings2 className="size-4" aria-hidden />
                    {t("linuxBackups.edit")}
                  </Button>
                  {plan.retention.enabled ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setAction({ plan, kind: "prune", archive: null })}
                    >
                      {t("linuxBackups.prune")}
                    </Button>
                  ) : null}
                </div>
              </div>
              {expanded === plan.id ? (
                <Archives
                  key={plan.id}
                  plan={plan}
                  busy={busy}
                  revision={`${revision}:${latestId}`}
                  onAction={setAction}
                />
              ) : null}
            </section>
          );
        })}
        <p className="text-xs leading-relaxed text-fg-subtle">{t("linuxBackups.recoveryHint")}</p>
        {data?.history.length ? (
          <details className="rounded-everyos-md border border-line p-4">
            <summary className="cursor-pointer text-xs font-medium">
              {t("linuxBackups.history")}
            </summary>
            <ul className="mt-3 divide-y divide-line">
              {data.history.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap justify-between gap-2 py-2 text-xs text-fg-muted"
                >
                  <span>
                    {data.plans.find((p) => p.id === item.planId)?.name} ·{" "}
                    {t(`linuxBackups.${titleKey[item.kind]}`)}
                  </span>
                  <span>
                    {t(`linuxBackups.${statusKey[item.status]}`)} ·{" "}
                    {formatDateTime(item.startedAt, i18n.language)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      {editing && data ? (
        <LinuxPlanDialog
          capability={data.capability}
          timezone={data.timezone}
          plan={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      ) : null}
      {action ? (
        <ActionDialog
          action={action}
          onClose={() => setAction(null)}
          onStarted={(job) => {
            setPendingJob(job);
            setPolling(true);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
