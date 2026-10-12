import type { BackupJobView, ReleaseJob, SelfUpdateStatus } from "@everyos/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { api } from "../../lib/api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { requestConfirm } from "../../desktop/menus/confirm.tsx";

const FAILURE_MESSAGES = {
  "release-metadata-invalid": "selfUpdate.errors.metadata",
  "recovery-package-invalid": "selfUpdate.errors.recovery",
  "package-download-failed": "selfUpdate.errors.download",
  "package-verification-failed": "selfUpdate.errors.verification",
  "snapshot-failed": "selfUpdate.errors.snapshot",
  "dpkg-install-failed": "selfUpdate.errors.installation",
  "service-health-failed": "selfUpdate.errors.health",
  "worker-start-failed": "selfUpdate.errors.worker",
  "new-release-failed-health-or-installation": "selfUpdate.errors.interrupted",
} as const;

export function SelfUpdatePanel() {
  const { t } = useTranslation();
  const canManage = usePermissions().includes("system:manage");
  const [status, setStatus] = useState<SelfUpdateStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [connectionError, setConnectionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const value = await api<SelfUpdateStatus>("/self-update");
        if (!disposed) {
          setStatus(value);
          setReconnecting(false);
          setConnectionError(null);
        }
      } catch (caught) {
        if (!disposed) {
          setConnectionError(caught);
          setReconnecting(true);
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api<SelfUpdateStatus>("/self-update/check", { method: "POST", body: {} }));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    const version = status?.available?.version;
    if (
      !version ||
      !(await requestConfirm({
        title: t("selfUpdate.confirmTitle"),
        body: t("selfUpdate.confirmBody", { version }),
        confirmLabel: t("selfUpdate.install"),
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setPreparing(true);
    setError(null);
    try {
      const initial = await api<BackupJobView>("/self-update/prepare", {
        method: "POST",
        body: {},
      });
      let job = initial;
      while (job.status === "running") {
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        const jobs = await api<{ job: BackupJobView | null; lastJob: BackupJobView | null }>(
          "/backups/job",
        );
        const current =
          jobs.job?.id === initial.id
            ? jobs.job
            : jobs.lastJob?.id === initial.id
              ? jobs.lastJob
              : null;
        if (!current) throw new Error("backup-preparation-failed");
        job = current;
      }
      if (job.status !== "succeeded" || !job.backupId) throw new Error("backup-preparation-failed");
      setPreparing(false);
      const queued = await api<ReleaseJob>("/self-update/install", {
        method: "POST",
        body: { version, backupId: job.backupId, confirm: true },
      });
      setStatus((previous) => (previous ? { ...previous, job: queued } : previous));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
      setPreparing(false);
    }
  };
  const running = status?.job && status.job.finishedAt === null;
  const failure = error ?? connectionError;
  const jobError = status?.job?.error;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4"
      data-testid="self-update-panel"
    >
      <div>
        <h2 className="font-semibold">{t("selfUpdate.title")}</h2>
        <p className="mt-1 text-sm text-fg-muted">{t("selfUpdate.description")}</p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-fg-muted">{t("selfUpdate.installed")}</dt>
        <dd className="font-mono">{status?.installedVersion ?? "—"}</dd>
        <dt className="text-fg-muted">{t("selfUpdate.available")}</dt>
        <dd className="font-mono">{status?.available?.version ?? "—"}</dd>
      </dl>
      {status?.reason ? <Alert>{t(`selfUpdate.reasons.${status.reason}`)}</Alert> : null}
      {status?.available?.notes ? (
        <p className="whitespace-pre-wrap text-sm">{status.available.notes}</p>
      ) : null}
      {preparing ? (
        <p role="status" className="text-sm">
          {t("selfUpdate.preparing")}
        </p>
      ) : null}
      {status?.job ? (
        <div role="status" className="rounded-everyos-md border border-line p-3 text-sm">
          <p>{t(`selfUpdate.states.${status.job.state}`)}</p>
          {status.job.error ? (
            <p className="mt-1 font-mono text-xs text-danger">
              {jobError && jobError in FAILURE_MESSAGES
                ? t(FAILURE_MESSAGES[jobError as keyof typeof FAILURE_MESSAGES])
                : t("selfUpdate.errors.interrupted")}
            </p>
          ) : null}
        </div>
      ) : null}
      {reconnecting && running ? (
        <p role="status" className="text-sm text-fg-muted">
          {t("selfUpdate.reconnecting")}
        </p>
      ) : failure ? (
        <Alert tone="danger">
          {failure instanceof Error && failure.message === "backup-preparation-failed"
            ? t("selfUpdate.backupFailed")
            : errorMessage(t, failure)}
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => void check()}
          loading={busy && !preparing}
          disabled={busy || !!running || !status?.configured}
        >
          {t("selfUpdate.check")}
        </Button>
      </div>
      {canManage && status?.available ? (
        <form
          className="flex max-w-sm flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void install();
          }}
        >
          <Button type="submit" loading={preparing} disabled={busy || !!running}>
            {t("selfUpdate.install")}
          </Button>
        </form>
      ) : null}
    </section>
  );
}
