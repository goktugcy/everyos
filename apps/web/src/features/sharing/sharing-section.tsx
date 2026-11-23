import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderSync, Network, RefreshCw, Share2 } from "lucide-react";
import { isErrorCode } from "@everyos/shared";
import type { NetworkConnection, NetworkFolderShare, SharingOverview } from "@everyos/shared";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Field, PasswordField } from "../../components/ui/field.tsx";
import { LoadingBlock } from "../../desktop/apps/system/parts.tsx";
import { api } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { errorMessage } from "../../lib/errors.ts";
import { formatDateTime, formatBytes } from "../../lib/format.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { requestConfirm } from "../../desktop/menus/confirm.tsx";
import { desktop } from "../../desktop/state/controller.ts";
import { filesChanged, type FileLocation } from "../../desktop/apps/files/lib.ts";
import { ConnectionForm, FolderShareForm } from "./forms.tsx";
import { QuickShareDialog, type QuickShareRequest } from "./quick-share-dialog.tsx";
import { LocationPicker } from "../drive/pickers.tsx";
import { providerStateText } from "../../desktop/apps/settings/remote-access-parts.tsx";

const tabs = ["overview", "connections", "sharedFolders", "quickShare", "settings"] as const;
type Tab = (typeof tabs)[number];
export function SharingSection({
  onBrowse,
}: {
  onBrowse?: ((location: FileLocation) => void) | undefined;
}) {
  const panelId = useId();
  const { t, i18n } = useTranslation(),
    permissions = usePermissions();
  const canManage = permissions.includes("system:manage"),
    canWrite = permissions.includes("files:write");
  const [now, setNow] = useState(() => Date.now());
  const [data, setData] = useState<SharingOverview | null>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [connection, setConnection] = useState<NetworkConnection | "new" | null>(null);
  const [folder, setFolder] = useState<NetworkFolderShare | "new" | null>(null);
  const [quick, setQuick] = useState<QuickShareRequest | null>(null),
    [picking, setPicking] = useState(false);
  const [smb, setSmb] = useState(false),
    [smbUser, setSmbUser] = useState(""),
    [smbPassword, setSmbPassword] = useState("");
  const [discovered, setDiscovered] = useState<Array<{
    name: string;
    host: string;
    port: number;
    protocol: string;
  }> | null>(null);
  const [preset, setPreset] = useState<
    { host: string; port: number; protocol: string } | undefined
  >();
  const refresh = useCallback(async () => {
    try {
      setData(await api<SharingOverview>("/sharing"));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<SharingOverview>("/sharing", { signal: controller.signal }).then(
      (value) => {
        setData(value);
        setError(null);
      },
      (e) => {
        if (!controller.signal.aborted) setError(e);
      },
    );
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    const next = data?.quickShares
      .filter((s) => !s.revoked && s.expiresAt > now)
      .map((s) => s.expiresAt)
      .sort((a, b) => a - b)[0];
    if (!next) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, next - now));
    return () => window.clearTimeout(timer);
  }, [data, now]);
  useEffect(() => {
    if (data?.host.installation?.state !== "running") return;
    const timer = window.setTimeout(() => void refresh(), 2000);
    return () => window.clearTimeout(timer);
  }, [data, refresh]);
  const action = async (
    path: string,
    body: unknown,
    method: "POST" | "DELETE" = "POST",
    remove = false,
  ) => {
    if (
      !(await requestConfirm({
        title: t("sharing.confirmTitle"),
        body:
          (remove ? t("sharing.removeConfirm") : t("sharing.confirmBody")) +
          " " +
          (data?.connections.find((c) => path.includes(c.id))?.name ??
            data?.shares.find((s) => path.includes(s.id))?.name ??
            data?.quickShares.find((s) => path.includes(s.id))?.name ??
            (typeof body === "object" &&
            body !== null &&
            "protocol" in body &&
            typeof body.protocol === "string"
              ? body.protocol.toUpperCase()
              : path.endsWith("/smb/account")
                ? smbUser
                : "")),
        confirmLabel: remove ? t("common.delete") : t("common.confirm"),
        danger: remove,
      }))
    )
      return false;
    setBusy(true);
    setError(null);
    try {
      await api(path, { method, body });
      filesChanged();
      await refresh();
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const browse = (location: FileLocation) =>
    onBrowse
      ? onBrowse(location)
      : desktop.openApp("everyos.files", { appState: { ...location, place: "files" } });
  const copyLink = async (id: string) => {
    try {
      const value = await api<{ url: string }>("/sharing/quick/" + id + "/link");
      await navigator.clipboard.writeText(value.url);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <section className="flex min-w-0 flex-col gap-5" data-testid="network-sharing">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Network className="size-5 text-accent" aria-hidden />
            {t("sharing.title")}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-fg-muted">{t("sharing.subtitle")}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("common.refresh")}
          onClick={() => void refresh()}
          disabled={busy}
        >
          <RefreshCw className="size-4" />
        </Button>
      </header>
      <div
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-line pb-2"
        role="tablist"
        aria-label={t("sharing.title")}
      >
        {tabs.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={panelId + "-" + value}
            aria-controls={panelId + "-panel"}
            tabIndex={tab === value ? 0 : -1}
            onKeyDown={(e) => {
              const current = tabs.indexOf(tab);
              const next =
                e.key === "ArrowRight"
                  ? (current + 1) % tabs.length
                  : e.key === "ArrowLeft"
                    ? (current + tabs.length - 1) % tabs.length
                    : e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? tabs.length - 1
                        : null;
              if (next === null) return;
              e.preventDefault();
              const value = tabs[next]!;
              setTab(value);
              document.getElementById(panelId + "-" + value)?.focus();
            }}
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              "shrink-0 rounded-everyos-sm px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent",
              tab === value
                ? "bg-accent/15 font-medium text-accent"
                : "text-fg-muted hover:bg-hover/8",
            )}
          >
            {t(`sharing.${value}`)}
          </button>
        ))}
      </div>
      {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
      {data?.host.source === "simulated" ? (
        <Alert tone="warning">{t("sharing.sourceMode")}</Alert>
      ) : null}
      {data && !data.host.supported ? (
        <Alert tone="warning">
          {isErrorCode(data.host.reason)
            ? t(`errors.${data.host.reason}`)
            : t("sharing.nativeUnavailable")}
        </Alert>
      ) : null}
      {!data && !error ? <LoadingBlock /> : null}
      <div
        role="tabpanel"
        id={panelId + "-panel"}
        aria-labelledby={panelId + "-" + tab}
        className="flex min-w-0 flex-col gap-5"
      >
        {data && (tab === "overview" || tab === "connections") ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">{t("sharing.connections")}</h3>
              <div className="flex flex-wrap gap-2">
                {canWrite ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setPreset(undefined);
                      setConnection("new");
                    }}
                  >
                    {t("sharing.addConnection")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void api<{ services: NonNullable<typeof discovered> }>("/sharing/discover")
                      .then((v) => setDiscovered(v.services), setError)
                      .finally(() => setBusy(false));
                  }}
                >
                  {t("sharing.discover")}
                </Button>
              </div>
            </div>
            {discovered ? (
              <div className="rounded-everyos-md border border-line p-3">
                {discovered.length ? (
                  discovered.map((s, index) => (
                    <button
                      type="button"
                      className="flex w-full flex-wrap justify-between gap-2 rounded p-2 text-left text-sm hover:bg-hover/8"
                      key={s.host + index}
                      onClick={() => {
                        setPreset(s);
                        setConnection("new");
                      }}
                      disabled={!canWrite}
                    >
                      <span>{s.name}</span>
                      <code className="text-xs">
                        {s.protocol.toUpperCase()} · {s.host}:{s.port}
                      </code>
                    </button>
                  ))
                ) : (
                  <p className="text-sm text-fg-muted">{t("sharing.discoveryUnavailable")}</p>
                )}
              </div>
            ) : null}
            {!data.connections.length ? (
              <p className="rounded-everyos-md border border-dashed border-line p-5 text-sm text-fg-muted">
                {t("sharing.empty")}
              </p>
            ) : (
              data.connections.map((c) => (
                <article
                  className="flex flex-col gap-3 rounded-everyos-md border border-line p-4"
                  key={c.id}
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="flex items-center gap-2 font-medium">
                        <FolderSync className="size-4 shrink-0 text-accent" aria-hidden />
                        {c.name}
                      </h4>
                      <p className="mt-1 break-all text-xs text-fg-subtle">
                        {c.protocol.toUpperCase()} · {c.host}:{c.port} · {c.remotePath}
                      </p>
                      {c.mountPoint ? (
                        <code className="mt-1 block break-all text-xs text-fg-subtle">
                          {c.mountPoint}
                        </code>
                      ) : null}
                    </div>
                    <span
                      className={cn(
                        "text-xs",
                        c.state === "connected"
                          ? "text-success"
                          : c.state === "unavailable" || c.state === "error"
                            ? "text-warning"
                            : "text-fg-muted",
                      )}
                    >
                      {t(`sharing.${c.state}`)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => browse({ root: c.root, path: "" })}
                      disabled={!c.enabled}
                    >
                      {t("common.open")}
                    </Button>
                    {canWrite ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            void action("/sharing/connections/" + c.id + "/control", {
                              action: c.state === "connected" ? "disconnect" : "connect",
                              confirm: true,
                            })
                          }
                          disabled={busy || !c.enabled}
                        >
                          {c.state === "connected" ? t("sharing.disconnect") : t("sharing.connect")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConnection(c)}>
                          {t("common.edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void action(
                              "/sharing/connections/" + c.id,
                              { confirm: true },
                              "DELETE",
                              true,
                            )
                          }
                          disabled={busy}
                        >
                          {t("common.delete")}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </article>
              ))
            )}
          </div>
        ) : null}
        {data && (tab === "overview" || tab === "sharedFolders") ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap justify-between gap-2">
              <h3 className="font-semibold">{t("sharing.sharedFolders")}</h3>
              {canManage ? (
                <Button size="sm" onClick={() => setFolder("new")}>
                  {t("sharing.addShare")}
                </Button>
              ) : null}
            </div>
            {!data.shares.length ? (
              <p className="rounded-everyos-md border border-dashed border-line p-5 text-sm text-fg-muted">
                {t("sharing.empty")}
              </p>
            ) : (
              data.shares.map((s) => (
                <article
                  key={s.id}
                  className="flex flex-col gap-2 rounded-everyos-md border border-line p-4"
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <h4 className="flex items-center gap-2 font-medium">
                      <Share2 className="size-4 text-accent" aria-hidden />
                      {s.name}
                    </h4>
                    <span className="text-xs text-fg-muted">
                      {s.protocol.toUpperCase()} · {t(`sharing.${s.state}`)}
                    </span>
                  </div>
                  <code className="break-all text-xs">
                    {s.root}:{s.path}
                  </code>
                  <p className="break-all text-xs text-fg-subtle">
                    {s.protocol === "nfs" ? s.clients.join(", ") : s.users.join(", ")} ·{" "}
                    {s.readOnly ? t("sharing.readOnly") : t("sharing.readWrite")}
                  </p>
                  <div className="flex flex-col gap-1 text-xs">
                    {data.host.addresses.slice(0, 8).map((address) => (
                      <code key={address} className="break-all">
                        {s.protocol === "smb"
                          ? "smb://" +
                            (address.includes(":") ? "[" + address + "]" : address) +
                            "/" +
                            encodeURIComponent(s.name)
                          : (address.includes(":") ? "[" + address + "]" : address) +
                            ":/srv/everyos-network-shares/" +
                            s.id}
                      </code>
                    ))}
                  </div>
                  {s.protocol === "smb" ? (
                    <p className="text-xs leading-relaxed text-fg-muted">
                      {t("sharing.appleInstructions")}
                    </p>
                  ) : null}
                  {canManage ? (
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setFolder(s)}>
                        {t("common.edit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void action("/sharing/folders/" + s.id, { confirm: true }, "DELETE", true)
                        }
                        disabled={busy}
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                  ) : null}
                </article>
              ))
            )}
          </div>
        ) : null}
        {data &&
        (tab === "overview" || tab === "connections") &&
        data.host.mounts.some((m) => !m.managed) ? (
          <div className="flex flex-col gap-2">
            <h3 className="font-semibold">{t("sharing.existingMounts")}</h3>
            {data.host.mounts
              .filter((m) => !m.managed)
              .map((m) => (
                <code
                  key={m.target}
                  className="break-all rounded-everyos-sm border border-line p-3 text-xs"
                >
                  {m.protocol.toUpperCase()} · {m.source} → {m.target} ·{" "}
                  {m.readOnly ? t("sharing.readOnly") : t("sharing.readWrite")}
                </code>
              ))}
          </div>
        ) : null}
        {data &&
        (tab === "overview" || tab === "sharedFolders") &&
        data.host.externalExports.length ? (
          <div className="flex flex-col gap-2">
            <h3 className="font-semibold">{t("sharing.existingExports")}</h3>
            {data.host.externalExports.map((e, i) => (
              <code key={i} className="break-all rounded-everyos-sm border border-line p-3 text-xs">
                {e.path} · {e.client}
              </code>
            ))}
          </div>
        ) : null}
        {data && tab === "quickShare" ? (
          <div className="flex flex-col gap-4">
            <Alert tone="info">{t("sharing.privateHint")}</Alert>
            <div className="flex flex-wrap gap-2">
              {canWrite ? (
                <>
                  <Button onClick={() => desktop.openApp("everyos.files")}>
                    {t("sharing.send")}
                  </Button>
                  <Button variant="secondary" onClick={() => setPicking(true)}>
                    {t("sharing.receive")}
                  </Button>
                </>
              ) : null}
            </div>
            {!data.quickShares.length ? (
              <p className="text-sm text-fg-muted">{t("sharing.empty")}</p>
            ) : (
              data.quickShares.map((s) => (
                <article
                  key={s.id}
                  className="flex flex-col gap-2 rounded-everyos-md border border-line p-4"
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <h4 className="font-medium">{s.name}</h4>
                    <span className="text-xs text-fg-muted">
                      {s.revoked || s.expiresAt <= now
                        ? t("sharing.inactive")
                        : s.exhausted
                          ? t("sharing.quotaReached")
                          : s.oneTime && s.claimed
                            ? t("sharing.claimed")
                            : t("sharing.active")}
                    </span>
                  </div>
                  <p className="text-xs text-fg-muted">
                    {t("sharing.expires")}: {formatDateTime(s.expiresAt, i18n.language)} ·{" "}
                    {s.direction === "send"
                      ? s.downloads + " / " + s.maxDownloads
                      : formatBytes(s.bytesReceived, i18n.language) +
                        " / " +
                        formatBytes(s.maxBytes, i18n.language)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void copyLink(s.id)}
                      disabled={
                        s.revoked || s.expiresAt <= now || s.exhausted || (s.oneTime && s.claimed)
                      }
                    >
                      {t("sharing.copyLink")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void action("/sharing/quick/" + s.id, { confirm: true }, "DELETE", true)
                      }
                      disabled={busy || s.revoked}
                    >
                      {t("sharing.revoke")}
                    </Button>
                  </div>
                </article>
              ))
            )}
          </div>
        ) : null}
        {data && tab === "settings" ? (
          <div className="flex flex-col gap-4">
            <Alert tone="info">{t("sharing.linuxAccountHint")}</Alert>
            <h3 className="font-semibold">{t("sharing.dependencies")}</h3>
            {data.host.services.map((service) => (
              <div
                key={service.protocol}
                className="flex flex-wrap items-center justify-between gap-2 rounded-everyos-md border border-line p-3"
              >
                <div>
                  <h4 className="text-sm font-medium">
                    {service.protocol === "nfs-client"
                      ? t("sharing.nfsClient")
                      : service.protocol === "smb-client"
                        ? t("sharing.smbClient")
                        : service.protocol === "discovery"
                          ? t("sharing.discoveryService")
                          : service.protocol.toUpperCase()}
                  </h4>
                  <p className="text-xs text-fg-subtle">
                    {service.installed && service.protocol.endsWith("-client")
                      ? t("sharing.installed")
                      : service.active
                        ? t("sharing.active")
                        : service.installed
                          ? t("sharing.inactive")
                          : t("sharing.unavailable")}
                  </p>
                </div>
                {canManage ? (
                  <div className="flex gap-2">
                    {!service.installed ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={
                          busy ||
                          !service.installSupported ||
                          data.host.installation?.state === "running"
                        }
                        onClick={() =>
                          void action("/sharing/services/install", {
                            protocol: service.protocol,
                            confirm: true,
                          })
                        }
                      >
                        {t("sharing.install")}
                      </Button>
                    ) : ["nfs", "smb", "sftp", "discovery"].includes(service.protocol) ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void action("/sharing/services/control", {
                            protocol: service.protocol,
                            action: service.active ? "reload" : "start",
                            confirm: true,
                          })
                        }
                      >
                        {service.active ? t("sharing.reload") : t("sharing.start")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
            {data.host.installation?.state === "running" ? (
              <LoadingBlock />
            ) : data.host.installation?.state === "failed" ? (
              <Alert tone="danger">{t("sharing.error")}</Alert>
            ) : null}
            {canManage ? (
              <Button variant="secondary" onClick={() => setSmb(true)}>
                {t("sharing.smbAccount")}
              </Button>
            ) : null}
            <h3 className="font-semibold">{t("sharing.addresses")}</h3>
            <div className="flex flex-wrap gap-2">
              {data.host.addresses.map((a) => (
                <code key={a} className="rounded bg-hover/8 p-2 text-xs">
                  {a}
                </code>
              ))}
            </div>
            <h3 className="font-semibold">{t("settings.sections.remoteAccess")}</h3>
            <Alert tone="info">{t("sharing.vpnHint")}</Alert>
            {data.privateNetworks.map((node) => (
              <div
                key={node.provider}
                className="rounded-everyos-md border border-line p-3 text-sm"
              >
                <div className="flex justify-between gap-2">
                  <span>{node.provider === "tailscale" ? "Tailscale" : "NetBird"}</span>
                  <span className="text-xs text-fg-muted">{providerStateText(t, node)}</span>
                </div>
                <p className="mt-1 break-all text-xs text-fg-subtle">
                  {node.addresses.join(" · ")}
                </p>
                {node.source === "simulated" ? (
                  <p className="text-xs text-warning">{t("sharing.sourceMode")}</p>
                ) : null}
              </div>
            ))}
            <Button
              variant="secondary"
              onClick={() =>
                desktop.openApp("everyos.settings", { appState: { section: "remoteAccess" } })
              }
            >
              {t("settings.sections.remoteAccess")}
            </Button>
            <p className="text-sm leading-relaxed text-fg-muted">{t("sharing.sftpHint")}</p>
            {data.host.sshPorts.map((port) => (
              <code key={port} className="break-all text-xs">
                SFTP · {port}
              </code>
            ))}
            <p className="text-sm leading-relaxed text-fg-muted">
              {t("sharing.appleInstructions")}
            </p>
            <p className="text-sm leading-relaxed text-fg-muted">
              {t("sharing.androidInstructions")}
            </p>
            <p className="text-sm leading-relaxed text-fg-muted">{t("sharing.pcInstructions")}</p>
            <Alert tone="warning">{t("sharing.resumeHint")}</Alert>
          </div>
        ) : null}
      </div>
      {connection ? (
        <ConnectionForm
          connection={connection === "new" ? undefined : connection}
          preset={preset}
          onClose={() => setConnection(null)}
          onSaved={() => void refresh()}
        />
      ) : null}
      {folder ? (
        <FolderShareForm
          share={folder === "new" ? undefined : folder}
          onClose={() => setFolder(null)}
          onSaved={() => void refresh()}
        />
      ) : null}
      {picking ? (
        <LocationPicker
          title={t("sharing.selectFolder")}
          confirmLabel={t("common.open")}
          onClose={() => setPicking(false)}
          onPick={(location) => {
            setPicking(false);
            setQuick({ direction: "receive", location, paths: [] });
          }}
        />
      ) : null}
      {quick ? (
        <QuickShareDialog
          request={quick}
          onClose={() => setQuick(null)}
          onSaved={() => void refresh()}
        />
      ) : null}
      {smb ? (
        <Dialog open onOpenChange={(v) => !v && setSmb(false)} title={t("sharing.smbAccount")}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void action("/sharing/smb/account", {
                username: smbUser,
                password: smbPassword,
                confirm: true,
              }).then((saved) => {
                if (!saved) return;
                setSmbPassword("");
                setSmb(false);
              });
            }}
          >
            <p className="text-sm text-fg-muted">{t("sharing.smbCredentialHint")}</p>
            <Field
              label={t("sharing.username")}
              value={smbUser}
              onChange={(e) => setSmbUser(e.target.value)}
              required
            />
            <PasswordField
              label={t("sharing.password")}
              value={smbPassword}
              onChange={(e) => setSmbPassword(e.target.value)}
              minLength={12}
              required
              autoComplete="new-password"
            />
            <Button type="submit" loading={busy}>
              {t("common.save")}
            </Button>
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}
export default SharingSection;
