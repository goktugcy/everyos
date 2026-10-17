import type { DriveClientView } from "@everyos/shared";
import { Cloud, ExternalLink, FolderOpen } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Field } from "../../../components/ui/field.tsx";
import {
  driveApi,
  parseConsentAnswer,
  redirectUri,
  refreshDriveAccount,
  useDriveAccount,
} from "../../../features/drive/drive.ts";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { desktop } from "../../state/controller.ts";
import { LoadingBlock } from "../system/parts.tsx";
import { SettingsGroup } from "./group.tsx";

/** Cloud accounts: each person's Google Drive, and the administrator's Google client. */
export default function ConnectionsSection() {
  const permissions = usePermissions();
  return (
    <div className="flex flex-col gap-8">
      {permissions.includes("files:read") ? <DriveAccountGroup /> : null}
      {permissions.includes("system:manage") ? <DriveClientGroup /> : null}
    </div>
  );
}

function DriveAccountGroup() {
  const { t, i18n } = useTranslation();
  const view = useDriveAccount((state) => state.view);
  const [consent, setConsent] = useState<{
    url: string;
    loopback: boolean;
    opened: boolean;
  } | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  const account = view?.account ?? null;
  const callbackError = useDriveAccount((state) => state.error);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const redirect = redirectUri();
      const { url } = await driveApi.connect(redirect);
      // Opened by the click itself, so the browser does not block it.
      const tab = window.open(url, "_blank");
      if (tab) tab.opener = null;
      setConsent({ url, loopback: !redirect.endsWith(":53682/"), opened: tab !== null });
      setAnswer("");
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const finish = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseConsentAnswer(answer);
    setInvalid(parsed === null);
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      await driveApi.complete(parsed.code, parsed.state);
      setConsent(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    const ok = await requestConfirm({
      title: t("drive.disconnectTitle"),
      body: t("drive.disconnectBody"),
      confirmLabel: t("drive.disconnect"),
      danger: true,
    });
    if (!ok) return;
    try {
      await driveApi.disconnect();
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <SettingsGroup title={t("drive.account")}>
      <div className="flex flex-col gap-3" data-testid="drive-account">
        {!view ? <LoadingBlock /> : null}
        {view && !view.configured ? (
          <p className="text-sm text-fg-muted">{t("drive.notConfigured")}</p>
        ) : null}
        {view?.configured && account ? (
          <div className="glass-inset flex flex-wrap items-center gap-3 rounded-everyos-md p-4">
            <Cloud className="size-6 text-accent" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">
                {t("drive.connected", { email: account.email })}
              </span>
              {account.quota?.usedBytes !== null && account.quota?.limitBytes ? (
                <span className="text-xs text-fg-muted">
                  {t("drive.quota", {
                    used: formatBytes(account.quota.usedBytes ?? 0, i18n.language),
                    limit: formatBytes(account.quota.limitBytes, i18n.language),
                  })}
                </span>
              ) : null}
            </div>
            {account.status === "connected" ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  desktop.openApp("everyos.files", {
                    newInstance: true,
                    appState: { place: "drive", driveFolder: "root" },
                  })
                }
              >
                <FolderOpen className="size-4" aria-hidden />
                {t("drive.openFiles")}
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => void disconnect()}>
              {t("drive.disconnect")}
            </Button>
          </div>
        ) : null}
        {account?.status === "reconnect" ? (
          <Alert tone="warning">{t("drive.reconnectNeeded")}</Alert>
        ) : null}
        {view?.configured && !account ? (
          <p className="text-sm text-fg-muted">{t("drive.notConnected")}</p>
        ) : null}
        {view?.configured && (!account || account.status === "reconnect") && !consent ? (
          <span>
            <Button loading={busy} onClick={() => void start()} data-testid="drive-connect">
              <Cloud className="size-4" aria-hidden />
              {account ? t("drive.reconnect") : t("drive.connect")}
            </Button>
          </span>
        ) : null}
        {/* Connecting may finish in Google's tab; then this form has done its job. */}
        {consent && account?.status !== "connected" ? (
          <form
            className="glass-inset flex flex-col gap-3 rounded-everyos-md p-4 text-sm"
            onSubmit={(event) => void finish(event)}
            data-testid="drive-consent"
          >
            {consent.opened ? (
              <p>{t("drive.connectSteps.opened")}</p>
            ) : (
              <a
                className="inline-flex items-center gap-1.5 text-accent underline"
                href={consent.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="size-4" aria-hidden />
                {t("drive.connectSteps.popupBlocked")}
              </a>
            )}
            <p className="text-fg-muted">
              {t(consent.loopback ? "drive.connectSteps.loopback" : "drive.connectSteps.paste")}
            </p>
            <Field
              label={t("drive.connectSteps.pasteLabel")}
              value={answer}
              placeholder="http://127.0.0.1:53682/?state=…&code=…"
              onChange={(event) => setAnswer(event.target.value)}
              error={invalid ? t("drive.connectSteps.invalid") : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConsent(null)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={busy} disabled={!answer.trim()}>
                {t("drive.connectSteps.finish")}
              </Button>
            </div>
          </form>
        ) : null}
        {error || callbackError ? (
          <Alert
            tone="danger"
            onDismiss={() => {
              setError(null);
              useDriveAccount.setState({ error: null });
            }}
          >
            {errorMessage(t, error ?? callbackError)}
          </Alert>
        ) : null}
      </div>
    </SettingsGroup>
  );
}

function DriveClientGroup() {
  const { t } = useTranslation();
  const [revision, setRevision] = useState(0);
  const client = useApiResource<DriveClientView>("/drive/client", null, revision);
  const [clientId, setClientId] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const current = client.data;
  const id = clientId ?? current?.clientId ?? "";
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api("/drive/client", {
        method: "PUT",
        body: { clientId: id.trim(), ...(secret.trim() ? { clientSecret: secret.trim() } : {}) },
      });
      setSecret("");
      setSaved(true);
      setRevision((n) => n + 1);
      await refreshDriveAccount();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const ok = await requestConfirm({
      title: t("drive.client.removeTitle"),
      body: t("drive.client.removeBody"),
      confirmLabel: t("drive.client.remove"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api("/drive/client", { method: "DELETE", body: { confirm: true } });
      setClientId(null);
      setRevision((n) => n + 1);
      await refreshDriveAccount();
    } catch (caught) {
      setError(caught);
    }
  };
  return (
    <SettingsGroup title={t("drive.client.title")} description={t("drive.client.hint")}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => void save(event)}
        data-testid="drive-client"
      >
        {current?.configured ? (
          <p className="text-sm text-fg-muted">
            {t("drive.client.configured", { clientId: current.clientId })}
          </p>
        ) : null}
        <details className="glass-inset rounded-everyos-md p-3 text-sm">
          <summary className="cursor-pointer font-medium">{t("drive.client.guideTitle")}</summary>
          <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-fg-muted">
            {(["step1", "step2", "step3", "step4", "step5", "step6"] as const).map((step) => (
              <li key={step}>{t(`drive.client.${step}`)}</li>
            ))}
          </ol>
        </details>
        <Field
          label={t("drive.client.clientId")}
          value={id}
          onChange={(event) => setClientId(event.target.value)}
          placeholder="123456789-abc.apps.googleusercontent.com"
          autoComplete="off"
          spellCheck={false}
        />
        <Field
          label={t("drive.client.clientSecret")}
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          autoComplete="new-password"
          hint={current?.configured ? t("drive.client.secretKept") : undefined}
        />
        {saved ? <Alert tone="success">{t("drive.client.saved")}</Alert> : null}
        {error ? (
          <Alert tone="danger" onDismiss={() => setError(null)}>
            {errorMessage(t, error)}
          </Alert>
        ) : null}
        <div className="flex justify-end gap-2">
          {current?.configured ? (
            <Button variant="ghost" onClick={() => void remove()}>
              {t("drive.client.remove")}
            </Button>
          ) : null}
          <Button type="submit" loading={busy} disabled={!id.trim()}>
            {t("drive.client.save")}
          </Button>
        </div>
      </form>
    </SettingsGroup>
  );
}
