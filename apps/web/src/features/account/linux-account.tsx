import type { LinuxAccount, LinuxAccountStatus, LinuxBinding } from "@everyos/shared";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { PasswordField } from "../../components/ui/field.tsx";
import { Select } from "../../components/ui/select.tsx";
import { api } from "../../lib/api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { formatDateTime } from "../../lib/format.ts";

export function LinuxBindingDialog({
  user,
  onClose,
  onDone,
}: {
  user: { id: string; displayName: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<{ accounts: LinuxAccount[]; bindings: LinuxBinding[] } | null>(
    null,
  );
  const [account, setAccount] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [linuxPassword, setLinuxPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!user) return;
    const abort = new AbortController();
    api<{ accounts: LinuxAccount[]; bindings: LinuxBinding[] }>("/users/linux-accounts", {
      signal: abort.signal,
    }).then(
      (result) => {
        setData(result);
        setAccount(
          result.bindings.find((b) => b.userId === user.id)?.account ??
            result.accounts[0]?.name ??
            "",
        );
      },
      (caught: unknown) => {
        if (!abort.signal.aborted) setError(caught);
      },
    );
    return () => abort.abort();
  }, [user]);
  const submit = async (event: FormEvent, unlink = false) => {
    event.preventDefault();
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/users/${encodeURIComponent(user.id)}/linux-account`, {
        method: unlink ? "DELETE" : "PUT",
        body: unlink ? { password: currentPassword } : { account, currentPassword, linuxPassword },
      });
      setCurrentPassword("");
      setLinuxPassword("");
      onDone();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setLinuxPassword("");
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={user !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("linux.link")}
      description={user?.displayName}
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <p className="text-sm text-fg-muted">{t("linux.linkHelp")}</p>
        {data?.accounts.length === 0 ? <Alert tone="warning">{t("linux.noAccounts")}</Alert> : null}
        <Select
          label={t("linux.account")}
          value={account}
          options={(data?.accounts ?? []).map((a) => ({
            value: a.name,
            label: t("linux.identity", { name: a.name, uid: a.uid }),
          }))}
          onChange={setAccount}
        />
        <PasswordField
          label={t("linux.everyosPassword")}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        <PasswordField
          label={t("linux.password")}
          value={linuxPassword}
          onChange={(e) => setLinuxPassword(e.target.value)}
          autoComplete="off"
          required
        />
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-3">
          {data?.bindings.some((b) => b.userId === user?.id) ? (
            <Button
              variant="ghost"
              disabled={busy || !currentPassword}
              onClick={(event) => void submit(event, true)}
            >
              {t("linux.unlink")}
            </Button>
          ) : null}
          <Button
            type="submit"
            loading={busy}
            disabled={!account || !currentPassword || !linuxPassword}
          >
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function LinuxAccountSection() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<LinuxAccountStatus | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const abort = new AbortController();
    const load = () => {
      void api<LinuxAccountStatus>("/account/linux", { signal: abort.signal }).then(
        setStatus,
        (caught: unknown) => {
          if (!abort.signal.aborted) setError(caught);
        },
      );
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, []);
  const run = async (unlock: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (unlock)
        setStatus(
          await api<LinuxAccountStatus>("/account/linux/unlock", {
            method: "POST",
            body: { linuxPassword: password },
          }),
        );
      else {
        await api("/account/linux/lock", { method: "POST" });
        setStatus((s) => s && { ...s, privilegedUntil: null });
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setPassword("");
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
      {status?.account ? (
        <>
          <p className="text-sm font-medium">
            {t("linux.identity", { name: status.account.name, uid: status.account.uid })}
          </p>
          <p className="break-all font-mono text-xs text-fg-muted">{status.account.home}</p>
          <p className="text-sm text-fg-muted">{t("linux.privilegeHelp")}</p>
          {status.privilegedUntil ? (
            <>
              <Alert tone="success">
                {t("linux.unlocked", {
                  time: formatDateTime(status.privilegedUntil, i18n.language),
                })}
              </Alert>
              <Button variant="secondary" loading={busy} onClick={() => void run(false)}>
                {t("linux.lock")}
              </Button>
            </>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(true);
              }}
            >
              <PasswordField
                label={t("linux.password")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                required
              />
              <Button type="submit" loading={busy} disabled={!password}>
                {t("linux.unlock")}
              </Button>
            </form>
          )}
        </>
      ) : status ? (
        <Alert tone="warning">{t("linux.required")}</Alert>
      ) : null}
    </div>
  );
}
