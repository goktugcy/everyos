import { LAN_HTTPS_PORT, type HttpsView } from "@everyos/shared";
import type { TFunction } from "i18next";
import { Download, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { SudoUnlock } from "../../../features/account/sudo-unlock.tsx";
import { api } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatDateTime } from "../../../lib/format.ts";
import { Toggle } from "../../menubar/quick-settings.tsx";
import { LoadingBlock } from "../system/parts.tsx";
import { SettingsGroup } from "./group.tsx";

/** A refusal reason as text, else the error itself. */
export function httpsError(t: TFunction, error: unknown): string {
  const reason = (error as { details?: { reason?: string } } | null)?.details?.reason;
  return reason && /^[a-z-]+$/.test(reason)
    ? t(`settings.https.reasons.${reason as "port-in-use"}`, {
        defaultValue: errorMessage(t, error),
      })
    : errorMessage(t, error);
}

/** Administrators: HTTPS through Tailscale Serve and on the local network. */
export function HttpsGroup() {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<HttpsView | null>(null);
  const [busy, setBusy] = useState<"tailscale" | "lan" | null>(null);
  const [error, setError] = useState<{ part: "tailscale" | "lan"; error: unknown } | null>(null);
  const [port, setPort] = useState(String(LAN_HTTPS_PORT));

  useEffect(() => {
    let active = true;
    api<HttpsView>("/https").then(
      (loaded) => {
        if (!active) return;
        setView(loaded);
        setPort(String(loaded.lan.port));
      },
      (caught: unknown) => active && setError({ part: "lan", error: caught }),
    );
    return () => {
      active = false;
    };
  }, []);

  const change = async (part: "tailscale" | "lan", body: object) => {
    setBusy(part);
    setError(null);
    try {
      setView(await api<HttpsView>(`/https/${part}`, { method: "PUT", body }));
    } catch (caught) {
      setError({ part, error: caught });
    } finally {
      setBusy(null);
    }
  };
  const failure = (part: "tailscale" | "lan") =>
    error?.part === part ? (
      <>
        <Alert tone="danger">{httpsError(t, error.error)}</Alert>
        <SudoUnlock error={error.error} />
      </>
    ) : null;

  if (!view)
    return (
      <SettingsGroup title={t("settings.https.title")}>
        {error ? <Alert tone="danger">{errorMessage(t, error.error)}</Alert> : <LoadingBlock />}
      </SettingsGroup>
    );
  const { tailscale, lan } = view;
  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535;

  return (
    <SettingsGroup title={t("settings.https.title")} description={t("settings.https.description")}>
      <div className="flex flex-col gap-3" data-testid="https-tailscale">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm font-medium">{t("settings.https.tailscale")}</span>
            <span className="text-xs leading-relaxed text-fg-muted">
              {tailscale.url
                ? t("settings.https.tailscaleOn", {
                    user: tailscale.enabledBy ?? "—",
                    date: formatDateTime(tailscale.enabledAt ?? 0, i18n.language),
                  })
                : t("settings.https.tailscaleHint")}
            </span>
            {tailscale.url ? (
              <a
                href={tailscale.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 break-all text-sm text-accent hover:underline"
              >
                {tailscale.url}
                <ExternalLink className="size-3.5 shrink-0" aria-hidden />
              </a>
            ) : null}
          </div>
          <Button
            size="sm"
            variant={tailscale.url ? "secondary" : "primary"}
            loading={busy === "tailscale"}
            onClick={() => void change("tailscale", { enabled: !tailscale.url })}
          >
            {tailscale.url ? t("settings.https.turnOff") : t("settings.https.tailscaleTurnOn")}
          </Button>
        </div>
        {failure("tailscale")}
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-4" data-testid="https-lan">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm font-medium">{t("settings.https.lan")}</span>
            <span className="text-xs leading-relaxed text-fg-muted">
              {t("settings.https.lanHint")}
            </span>
          </div>
          <Toggle
            checked={lan.enabled}
            disabled={busy === "lan" || (!lan.enabled && !portValid)}
            label={t("settings.https.lan")}
            onCheckedChange={(enabled) => void change("lan", { enabled, port: portNumber })}
          />
        </div>
        {!lan.enabled ? (
          <Field
            label={t("settings.https.port")}
            type="number"
            min={1024}
            max={65535}
            value={port}
            onChange={(event) => setPort(event.target.value)}
          />
        ) : null}
        {lan.enabled && lan.loopbackOnly ? (
          <Alert tone="warning">{t("settings.https.loopbackOnly")}</Alert>
        ) : null}
        {lan.enabled && lan.error ? (
          <Alert tone="danger">
            {t(`settings.https.reasons.${lan.error as "port-in-use"}`, { defaultValue: lan.error })}
          </Alert>
        ) : null}
        {lan.enabled && lan.listening ? (
          <div className="flex flex-col gap-2 text-xs">
            <span className="text-fg-muted">{t("settings.https.addresses")}</span>
            <ul className="flex flex-col gap-1">
              {lan.urls.map((url) => (
                <li key={url} className="break-all font-mono">
                  {url}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {lan.enabled && lan.authority ? (
          <div className="flex flex-col gap-2 rounded-everyos-md border border-line p-3 text-xs">
            <span className="font-medium">{t("settings.https.authority")}</span>
            <span className="leading-relaxed text-fg-muted">
              {t("settings.https.authorityHint")}
            </span>
            <code className="break-all font-mono text-[0.7rem]">{lan.authority.fingerprint}</code>
            {lan.certificate ? (
              <span className="text-fg-muted">
                {t("settings.https.certificateUntil", {
                  date: formatDateTime(lan.certificate.notAfter, i18n.language),
                })}
              </span>
            ) : null}
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const link = document.createElement("a");
                  link.href = "/api/https/authority.crt";
                  link.download = "everyos-ca.crt";
                  document.body.append(link);
                  link.click();
                  link.remove();
                }}
              >
                <Download className="size-4" aria-hidden />
                {t("settings.https.downloadAuthority")}
              </Button>
            </div>
          </div>
        ) : null}
        {failure("lan")}
      </div>
    </SettingsGroup>
  );
}
