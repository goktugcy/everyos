import type { LinuxBackupPlan } from "@everyos/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { PasswordField } from "../../../components/ui/field.tsx";
import { api } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";

export type LinuxPlanAction = { plan: LinuxBackupPlan; kind: "enable" | "disable" | "delete" };
const titles = { enable: "enablePlan", disable: "disablePlan", delete: "deletePlan" } as const;
const hints = {
  enable: "enablePlanHint",
  disable: "disablePlanHint",
  delete: "deletePlanHint",
} as const;

export function LinuxPlanActionDialog({
  action,
  onClose,
  onDone,
  onPendingChange,
}: {
  action: LinuxPlanAction;
  onClose: () => void;
  onDone: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog
      open
      title={t(`linuxBackups.${titles[action.kind]}`)}
      description={action.plan.name}
      onOpenChange={(open) => !open && !busy && onClose()}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          onPendingChange(true);
          setError(null);
          const removing = action.kind === "delete";
          void api(`/linux-backups/plans/${action.plan.id}${removing ? "" : "/state"}`, {
            method: removing ? "DELETE" : "PATCH",
            body: removing
              ? { password, confirm: true }
              : { password, enabled: action.kind === "enable" },
          })
            .then(onDone, (caught: unknown) => setError(caught))
            .finally(() => {
              setBusy(false);
              onPendingChange(false);
            });
        }}
      >
        <Alert tone={action.kind === "enable" ? "info" : "warning"}>
          {t(`linuxBackups.${hints[action.kind]}`)}
        </Alert>
        {action.kind === "delete" ? (
          <>
            <div className="text-xs text-fg-muted">
              <p>{t("linuxBackups.repositoryLocation")}</p>
              <p className="mt-1 break-all font-mono">
                {action.plan.targetPath.replace(/\/$/, "")}/everyos-linux-{action.plan.id}
                /repository
              </p>
            </div>
            {action.plan.encryption !== "none" ? (
              <Alert tone="warning">{t("linuxBackups.deletePlanEncryptedHint")}</Alert>
            ) : null}
          </>
        ) : null}
        <PasswordField
          label={t("linuxBackups.password")}
          value={password}
          required
          autoComplete="current-password"
          onChange={(event) => setPassword(event.currentTarget.value)}
        />
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant={action.kind === "delete" ? "danger" : "primary"}
            loading={busy}
            disabled={!password}
          >
            {t(`linuxBackups.${titles[action.kind]}`)}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
