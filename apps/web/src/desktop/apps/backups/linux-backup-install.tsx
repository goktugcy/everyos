import type { LinuxBackupCapability, LinuxBackupInstallation } from "@everyos/shared";
import { CheckCircle2, Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { PasswordField } from "../../../components/ui/field.tsx";
import { SudoUnlock } from "../../../features/account/sudo-unlock.tsx";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";

const stages = {
  preparing: "installPreparing",
  refreshing: "installRefreshing",
  installing: "installRunning",
  checking: "installChecking",
  done: "installComplete",
} as const;
const errors = {
  BORG_PACKAGE_UNAVAILABLE: "installPackageUnavailable",
  BORG_PACKAGE_VERSION: "installPackageVersion",
  BORG_INSTALL_BUSY: "installBusy",
  BORG_INSTALL_REFRESH_FAILED: "installRefreshFailed",
  BORG_INSTALL_INTERRUPTED: "installInterrupted",
  BORG_INSTALL_VERIFY_FAILED: "installVerifyFailed",
  LINUX_SUDO_REQUIRED: "installSudo",
  LINUX_ACCOUNT_REQUIRED: "installSudo",
} as const;

export function LinuxBackupInstall({
  capability,
  job,
  onStarted,
}: {
  capability: LinuxBackupCapability;
  job: LinuxBackupInstallation | null;
  onStarted: (job: LinuxBackupInstallation) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const running = job?.status === "running";
  if (capability.reason !== "borg-missing" && !job) return null;
  const errorKey =
    job?.error && Object.hasOwn(errors, job.error)
      ? errors[job.error as keyof typeof errors]
      : "installFailed";
  const unlockError = job?.error
    ? new ApiRequestError(403, "AGENT_OPERATION_DENIED", "", { reason: job.error })
    : null;
  return (
    <section className="shrink-0" aria-live="polite" data-testid="linux-backup-install">
      <Alert
        tone={
          job?.status === "succeeded" ? "success" : job?.status === "failed" ? "danger" : "info"
        }
      >
        <div className="flex items-center gap-2 font-medium">
          {running ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : job?.status === "succeeded" ? (
            <CheckCircle2 className="size-4" aria-hidden />
          ) : (
            <Download className="size-4" aria-hidden />
          )}
          <p role="status">
            {t(
              `linuxBackups.${running ? stages[job.stage] : job?.status === "succeeded" ? "installComplete" : "installTitle"}`,
            )}
          </p>
        </div>
        <p className="mt-2 text-xs leading-relaxed">{t("linuxBackups.installHint")}</p>
        {job?.status === "failed" ? (
          <p className="mt-2 text-sm">{t(`linuxBackups.${errorKey}`)}</p>
        ) : null}
        {job?.status === "failed" ? (
          <div className="mt-2">
            <SudoUnlock error={unlockError} />
          </div>
        ) : null}
        {!running && capability.reason === "borg-missing" ? (
          <div className="mt-3 flex flex-col items-start gap-2">
            <Button
              size="sm"
              disabled={!capability.installationSupported}
              onClick={() => {
                setPassword("");
                setError(null);
                setOpen(true);
              }}
            >
              <Download className="size-4" aria-hidden />
              {t("linuxBackups.install")}
            </Button>
            {!capability.installationSupported ? (
              <p className="text-xs">{t("linuxBackups.installUnsupported")}</p>
            ) : null}
          </div>
        ) : null}
      </Alert>
      <Dialog
        open={open}
        onOpenChange={(value) => !starting && setOpen(value)}
        title={t("linuxBackups.installTitle")}
        description={t("linuxBackups.installHint")}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setStarting(true);
            setError(null);
            void api<LinuxBackupInstallation>("/linux-backups/install", {
              method: "POST",
              body: { confirm: true, password },
            })
              .then(
                (value) => {
                  onStarted(value);
                  setOpen(false);
                  setPassword("");
                },
                (caught: unknown) => setError(caught),
              )
              .finally(() => setStarting(false));
          }}
        >
          <p className="text-sm leading-relaxed text-fg-muted">
            {t("linuxBackups.installConsent")}
          </p>
          <PasswordField
            label={t("linuxBackups.password")}
            value={password}
            required
            autoComplete="current-password"
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
          {error ? (
            <>
              <Alert tone="danger">{errorMessage(t, error)}</Alert>
              <SudoUnlock error={error} />
            </>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={starting} onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={starting} disabled={!password}>
              {t("linuxBackups.install")}
            </Button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
