import { useState, type FormEvent } from "react";
import { Tabs } from "radix-ui";
import { useTranslation } from "react-i18next";
import { ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import {
  REMOTE_ACCESS_PROVIDERS,
  isShortcutUrl,
  type RemoteAccessOverview,
  type RemoteAccessPeer,
  type RemoteAccessSettings,
} from "@everyos/shared";
import type { TFunction } from "i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";
import { TabsList } from "../../../components/ui/tabs-list.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { SudoUnlock } from "../../../features/account/sudo-unlock.tsx";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes, formatDateTime } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { useAppStateField } from "../app-context.ts";
import { desktop } from "../../state/controller.ts";
import { SettingsGroup } from "./group.tsx";

export function remoteAccessError(t: TFunction, error: unknown): string {
  const reason =
    typeof error === "string"
      ? error
      : error instanceof ApiRequestError
        ? (error.details as { reason?: unknown } | undefined)?.reason
        : null;
  if (typeof reason === "string" && /^REMOTE_[A-Z_]+$/.test(reason))
    return t(`remoteAccess.error_${reason.slice(7)}`, {
      defaultValue: t("errors.AGENT_OPERATION_FAILED"),
    });
  if (reason === "PACKAGE_ENVIRONMENT_UNSAFE" || reason === "PACKAGE_STATE_UNSAFE")
    return t(
      `packageSafety.${reason === "PACKAGE_ENVIRONMENT_UNSAFE" ? "unsafeEnvironment" : "unsafeState"}`,
      { defaultValue: t("errors.AGENT_OPERATION_DENIED") },
    );
  return errorMessage(t, error);
}
const warningKey = {
  "multiple-active": "multipleActive",
  dns: "dns",
  subnet: "subnet",
  "exit-node": "exitNode",
  "route-policy": "routePolicy",
  visibility: "visibility",
} as const;
const stateKey = {
  connected: "connected",
  connecting: "connecting",
  disconnected: "disconnected",
  "needs-login": "needsLogin",
  unknown: "unknown",
} as const;

export default function RemoteAccessSection() {
  const { t } = useTranslation();
  const permissions = usePermissions(),
    canRead = permissions.includes("system:read");
  const [selected, setSelected] = useAppStateField(
    "remoteAccessProvider",
    REMOTE_ACCESS_PROVIDERS,
    "tailscale",
  );
  const view = useApiResource<RemoteAccessOverview>(canRead ? "/remote-access" : null, 3_000);
  if (!canRead) return <Alert>{t("errors.FORBIDDEN")}</Alert>;
  return (
    <div className="space-y-6" data-testid="remote-access">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("remoteAccess.title")}</h2>
          <p className="mt-1 text-sm text-fg-muted">{t("remoteAccess.description")}</p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={view.reload}
          aria-label={t("remoteAccess.refresh")}
        >
          <RefreshCw
            className={
              view.loading || view.refreshing
                ? "size-4 animate-spin motion-reduce:animate-none"
                : "size-4"
            }
            aria-hidden
          />
        </Button>
      </div>
      {view.error ? <Alert tone="danger">{remoteAccessError(t, view.error)}</Alert> : null}
      {!view.data && view.loading ? <Spinner label={t("common.loading")} /> : null}
      {view.data ? (
        <>
          {view.data.conflicts.map((warning, index) => (
            <Alert
              key={`${warning.kind}-${index}`}
              tone={
                warning.severity === "critical"
                  ? "danger"
                  : warning.severity === "warning"
                    ? "warning"
                    : "info"
              }
            >
              <span>{t(`remoteAccess.warning_${warningKey[warning.kind]}`)}</span>
              {warning.routes.length ? (
                <span className="mt-1 block break-all font-mono text-xs">
                  {warning.routes.join(" · ")}
                </span>
              ) : null}
            </Alert>
          ))}
          <Tabs.Root
            value={selected}
            onValueChange={(value) => setSelected(value as typeof selected)}
            className="space-y-5"
          >
            <TabsList aria-label={t("remoteAccess.provider")} className="grid grid-cols-2 gap-2">
              {REMOTE_ACCESS_PROVIDERS.map((id) => {
                const node = view.data?.providers.find((item) => item.node.provider === id)?.node;
                return (
                  <Tabs.Trigger
                    key={id}
                    value={id}
                    className="flex min-h-16 min-w-0 items-center gap-3 rounded-everyos-md border border-line px-3 py-2 text-left outline-none data-[state=active]:border-accent data-[state=active]:bg-accent/10 focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <ShieldCheck className="size-5 shrink-0 text-accent" aria-hidden />
                    <span className="min-w-0">
                      <span className="block font-medium">{t(`remoteAccess.${id}`)}</span>
                      <span className="block text-xs text-fg-muted">
                        {node
                          ? t(
                              node.installed
                                ? `remoteAccess.state_${stateKey[node.state]}`
                                : "remoteAccess.notInstalled",
                            )
                          : t("remoteAccess.unknown")}
                      </span>
                    </span>
                  </Tabs.Trigger>
                );
              })}
            </TabsList>
            {view.data.providers.map((entry) => (
              <Tabs.Content key={entry.node.provider} value={entry.node.provider}>
                <ProviderPanel
                  entry={entry}
                  canManage={view.data!.canManage}
                  installing={view.data!.providers.some(
                    (item) => item.installation?.status === "running",
                  )}
                  otherActive={view.data!.providers.some(
                    (item) =>
                      item.node.provider !== entry.node.provider && item.node.state === "connected",
                  )}
                  reload={view.reload}
                />
              </Tabs.Content>
            ))}
          </Tabs.Root>
        </>
      ) : null}
    </div>
  );
}

function ProviderPanel({
  entry,
  canManage,
  installing,
  otherActive,
  reload,
}: {
  entry: RemoteAccessOverview["providers"][number];
  canManage: boolean;
  installing: boolean;
  otherActive: boolean;
  reload: () => void;
}) {
  const { t, i18n } = useTranslation(),
    node = entry.node;
  const [settings, setSettings] = useState<RemoteAccessSettings>(entry.settings);
  const [mode, setMode] = useState<"cloud" | "selfHosted">(
    entry.settings.managementUrl &&
      !/^https:\/\/api\.netbird\.io(?::443)?\/?$/.test(entry.settings.managementUrl)
      ? "selfHosted"
      : "cloud",
  );
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [saved, setSaved] = useState(false);
  const [action, setAction] = useState<"connect" | "disconnect" | "install" | null>(null);
  const [acknowledge, setAcknowledge] = useState(false),
    [configureRepository, setConfigureRepository] = useState(true);
  const [showPeers, setShowPeers] = useState(false);
  const peers = useApiResource<{ peers: RemoteAccessPeer[] }>(
    canManage && showPeers && node.installed ? `/remote-access/${node.provider}/peers` : null,
    10_000,
  );
  const dirty = JSON.stringify(settings) !== JSON.stringify(entry.settings);
  const url = settings.managementUrl;
  const valid =
    node.provider === "tailscale" ||
    Boolean(url && isShortcutUrl(url) && /^https:\/\/[^/?#]+\/?$/i.test(url));
  const boolean = (value: boolean | null) =>
    t(value === null ? "remoteAccess.unknown" : value ? "remoteAccess.yes" : "remoteAccess.no");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/remote-access/${node.provider}/settings`, {
        method: "PUT",
        body: { ...settings, confirm: true },
      });
      setSaved(true);
      reload();
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };
  const execute = async () => {
    if (!action || (action === "connect" && otherActive && !acknowledge)) return;
    setBusy(true);
    setError(null);
    const key = credential;
    setCredential("");
    try {
      await api(`/remote-access/${node.provider}/${action}`, {
        method: "POST",
        body:
          action === "connect"
            ? {
                confirm: true,
                acknowledgeConflicts: acknowledge,
                ...(key.trim() ? { credential: key.trim() } : {}),
              }
            : action === "install"
              ? { confirm: true, configureRepository }
              : { confirm: true },
      });
      setAction(null);
      reload();
    } catch (error) {
      setError(error);
      reload();
      if (
        error instanceof ApiRequestError &&
        ["LINUX_ACCOUNT_REQUIRED", "LINUX_SUDO_REQUIRED"].includes(
          String((error.details as { reason?: string } | undefined)?.reason),
        )
      )
        setAction(null);
    } finally {
      setBusy(false);
    }
  };
  const begin = (next: typeof action) => {
    setError(null);
    setAcknowledge(false);
    setAction(next);
  };
  const job = entry.installation;
  return (
    <div className="space-y-5" data-testid={`remote-provider-${node.provider}`}>
      {node.source === "simulated" ? (
        <Alert tone="warning">{t("remoteAccess.simulated")}</Alert>
      ) : null}
      {node.installed && !node.available ? (
        <Alert tone="warning">{t("remoteAccess.unavailable")}</Alert>
      ) : null}
      <SettingsGroup title={t(`remoteAccess.${node.provider}`)}>
        <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-x-3 gap-y-2 text-sm">
          {[
            [t("remoteAccess.host"), node.hostName ?? t("remoteAccess.unknown")],
            [t("remoteAccess.version"), node.version ?? t("remoteAccess.unknown")],
            [t("remoteAccess.addresses"), node.addresses.join(", ") || t("remoteAccess.none")],
            [t("remoteAccess.dns"), boolean(node.dnsEnabled)],
            [t("remoteAccess.exitNode"), boolean(node.defaultRoute)],
            [
              t("remoteAccess.routes"),
              node.routes.join(", ") ||
                t(node.routeVisibility ? "remoteAccess.none" : "remoteAccess.unknown"),
            ],
            [t("remoteAccess.peers"), t("remoteAccess.peerCounts", node.peers)],
          ].map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-fg-muted">{label}</dt>
              <dd className="min-w-0 break-words [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {!node.installed ? (
              <Button
                disabled={busy || installing || !node.installationSupported}
                onClick={() => begin("install")}
              >
                {t("remoteAccess.install")}
              </Button>
            ) : (
              <>
                <Button disabled={busy || installing || dirty} onClick={() => begin("connect")}>
                  {t("remoteAccess.connect")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    busy ||
                    installing ||
                    node.state === "disconnected" ||
                    node.state === "needs-login"
                  }
                  onClick={() => begin("disconnect")}
                >
                  {t("remoteAccess.disconnect")}
                </Button>
              </>
            )}
          </div>
        ) : (
          <p className="text-xs text-fg-muted">{t("remoteAccess.viewer")}</p>
        )}
        {!node.installed && !node.installationSupported ? (
          <p className="text-xs text-fg-muted">{t("remoteAccess.installationUnsupported")}</p>
        ) : null}
        {node.provider === "tailscale" ? (
          <Button variant="ghost" size="sm" onClick={() => desktop.openApp("everyos.tailscale")}>
            <ExternalLink className="size-4" aria-hidden />
            {t("remoteAccess.diagnostics")}
          </Button>
        ) : null}
      </SettingsGroup>
      {job ? (
        <Alert
          tone={
            job.status === "failed" ? "danger" : job.status === "succeeded" ? "success" : "info"
          }
        >
          <div className="flex items-center gap-2" role="status">
            {job.status === "running" ? <Spinner className="size-4" /> : null}
            <span>
              {job.status === "running"
                ? t(`remoteAccess.stage_${job.stage}`)
                : t(
                    job.status === "succeeded"
                      ? "remoteAccess.installSucceeded"
                      : "remoteAccess.installFailed",
                  )}
            </span>
          </div>
          {job.status === "running" ? (
            <p className="mt-1 text-xs">{t("remoteAccess.installationRunning")}</p>
          ) : job.error ? (
            <p className="mt-1 text-xs">{remoteAccessError(t, job.error)}</p>
          ) : null}
        </Alert>
      ) : null}
      {canManage ? (
        <SettingsGroup
          title={t("remoteAccess.configure")}
          description={t("remoteAccess.settingsHint")}
        >
          <form className="space-y-4" onSubmit={save}>
            {node.provider === "netbird" ? (
              <>
                <Select
                  label={t("remoteAccess.mode")}
                  value={mode}
                  options={[
                    { value: "cloud", label: t("remoteAccess.cloud") },
                    { value: "selfHosted", label: t("remoteAccess.selfHosted") },
                  ]}
                  onChange={(value) => {
                    setMode(value);
                    setSettings({
                      ...settings,
                      managementUrl: value === "cloud" ? "https://api.netbird.io" : "",
                    });
                    setSaved(false);
                  }}
                  disabled={busy}
                />
                {mode === "selfHosted" ? (
                  <Field
                    label={t("remoteAccess.management")}
                    value={settings.managementUrl ?? ""}
                    onChange={(event) => {
                      setSettings({ ...settings, managementUrl: event.target.value.trim() });
                      setSaved(false);
                    }}
                    maxLength={2048}
                    hint={t("remoteAccess.managementHint")}
                    error={!valid ? t("remoteAccess.managementHint") : undefined}
                    disabled={busy}
                  />
                ) : null}
              </>
            ) : null}
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={settings.acceptDNS}
                onChange={(event) => {
                  setSettings({ ...settings, acceptDNS: event.target.checked });
                  setSaved(false);
                }}
                disabled={busy}
              />
              {t("remoteAccess.acceptDNS")}
            </label>
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={settings.acceptRoutes}
                onChange={(event) => {
                  setSettings({ ...settings, acceptRoutes: event.target.checked });
                  setSaved(false);
                }}
                disabled={busy}
              />
              {t("remoteAccess.acceptRoutes")}
            </label>
            <Button
              type="submit"
              variant="secondary"
              disabled={!valid || !dirty}
              loading={busy && action === null}
            >
              {t("remoteAccess.save")}
            </Button>
            {saved ? (
              <p className="text-xs text-success" role="status">
                {t("remoteAccess.saved")}
              </p>
            ) : null}
          </form>
          {node.installed ? (
            <Field
              type="password"
              autoComplete="off"
              label={t("remoteAccess.credential")}
              hint={t("remoteAccess.credentialHint")}
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              maxLength={4096}
              disabled={busy}
            />
          ) : null}
          {dirty ? <p className="text-xs text-fg-muted">{t("remoteAccess.saveFirst")}</p> : null}
        </SettingsGroup>
      ) : null}
      {!canManage ? (
        <p className="text-xs text-fg-muted">{t("remoteAccess.peersPrivate")}</p>
      ) : node.installed ? (
        <SettingsGroup title={t("remoteAccess.peers")}>
          <Button variant="secondary" onClick={() => setShowPeers(!showPeers)}>
            {t(showPeers ? "remoteAccess.hidePeers" : "remoteAccess.showPeers")}
          </Button>
          {showPeers && peers.error ? (
            <>
              <Alert tone="danger">{remoteAccessError(t, peers.error)}</Alert>
              <SudoUnlock error={peers.error} />
            </>
          ) : null}
          {showPeers && peers.loading && !peers.data ? (
            <Spinner label={t("common.loading")} />
          ) : null}
          {showPeers && peers.data ? (
            <ul className="space-y-2">
              {!peers.data.peers.length ? (
                <li className="text-sm text-fg-muted">{t("remoteAccess.noPeers")}</li>
              ) : null}
              {peers.data.peers.map((peer, index) => (
                <li key={index} className="rounded-everyos-md border border-line p-3 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="break-all font-medium">
                      {peer.name ?? t("remoteAccess.unknown")}
                    </span>
                    <span className="text-fg-muted">
                      {t(
                        peer.online === null
                          ? "remoteAccess.unknown"
                          : peer.online
                            ? "remoteAccess.state_connected"
                            : "remoteAccess.state_disconnected",
                      )}
                    </span>
                  </div>
                  <p className="break-all text-xs text-fg-muted">{peer.addresses.join(" · ")}</p>
                  <p className="mt-1 text-xs">
                    {t(`remoteAccess.${peer.connection}`)} ·{" "}
                    {formatBytes(peer.rxBytes, i18n.language)} /{" "}
                    {formatBytes(peer.txBytes, i18n.language)}
                  </p>
                  {peer.lastSeen ? (
                    <p className="mt-1 text-xs text-fg-subtle">
                      {t("remoteAccess.lastSeen")}: {formatDateTime(peer.lastSeen, i18n.language)}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </SettingsGroup>
      ) : null}
      {error && !action ? <Alert tone="danger">{remoteAccessError(t, error)}</Alert> : null}
      {!action ? <SudoUnlock error={error} /> : null}
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null);
        }}
        title={t(
          action === "install"
            ? "remoteAccess.confirmInstall"
            : action === "disconnect"
              ? "remoteAccess.confirmDisconnect"
              : "remoteAccess.confirmConnect",
          { provider: t(`remoteAccess.${node.provider}`) },
        )}
        className="!z-[8500]"
        overlayClassName="!z-[8490]"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAction(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant={action === "disconnect" ? "danger" : "primary"}
              loading={busy}
              disabled={action === "connect" && otherActive && !acknowledge}
              onClick={() => void execute()}
            >
              {t(
                action === "install"
                  ? "remoteAccess.install"
                  : action === "disconnect"
                    ? "remoteAccess.disconnect"
                    : "remoteAccess.connect",
              )}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">
            {t(
              action === "install"
                ? "remoteAccess.installHint"
                : action === "disconnect"
                  ? "remoteAccess.disconnectHint"
                  : "remoteAccess.connectHint",
              {
                repository: node.provider === "netbird" ? "pkgs.netbird.io" : "pkgs.tailscale.com",
              },
            )}
          </p>
          {action === "connect" && node.provider === "netbird" ? (
            <p className="break-all text-sm">
              {entry.settings.managementUrl ?? node.managementUrl ?? "https://api.netbird.io"}
            </p>
          ) : null}
          {action === "connect" && otherActive ? (
            <label className="flex min-h-11 items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={acknowledge}
                onChange={(event) => setAcknowledge(event.target.checked)}
                disabled={busy}
              />
              <span>{t("remoteAccess.acknowledge")}</span>
            </label>
          ) : null}
          {action === "install" ? (
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={configureRepository}
                onChange={(event) => setConfigureRepository(event.target.checked)}
                disabled={busy}
              />
              {t("remoteAccess.configureRepository")}
            </label>
          ) : null}
          {error ? <Alert tone="danger">{remoteAccessError(t, error)}</Alert> : null}
        </div>
      </Dialog>
    </div>
  );
}
