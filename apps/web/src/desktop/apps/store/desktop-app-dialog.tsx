import type {
  DesktopAppInstallationView,
  DesktopAppListing,
  DesktopAppPermissionView,
} from "@everyos/shared";
import { AppWindow, ExternalLink, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { api } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { formatDateTime } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import {
  desktopAppWindowId,
  refreshDesktopApps,
  useDesktopApps,
} from "../../desktop-apps/store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { desktop } from "../../state/controller.ts";
import { ResourceError } from "../system/parts.tsx";
import { NetworkRules } from "./network-rules.tsx";

/** i18next reads `:` and `.` as separators: capability names become safe keys. */
export function capabilityKey(capability: string): string {
  return capability.startsWith("integration:") ? "integration" : capability.replace(/[:.]/g, "_");
}

const RISK_STYLE: Record<DesktopAppPermissionView["risk"], string> = {
  standard: "bg-hover/12 text-fg-muted",
  sensitive: "bg-warning/15 text-warning",
  elevated: "bg-danger/15 text-danger",
};

export function PermissionList({
  permissions,
  approvable,
  approved,
  onToggle,
}: {
  permissions: Array<DesktopAppPermissionView & { granted?: boolean }>;
  /** Capabilities that need a tick before the action (sensitive and elevated ones). */
  approvable?: ReadonlySet<string>;
  approved?: ReadonlySet<string>;
  onToggle?: (capability: string) => void;
}) {
  const { t } = useTranslation();
  if (!permissions.length)
    return <p className="text-sm text-fg-muted">{t("desktopApps.store.noPermissions")}</p>;
  return (
    <ul className="flex flex-col gap-2" data-testid="desktop-app-permissions">
      {permissions.map((permission) => {
        const key = capabilityKey(permission.capability);
        const adapter = permission.capability.split(":")[1] ?? "";
        const needsTick = approvable?.has(permission.capability) ?? false;
        return (
          <li
            key={permission.capability}
            className="glass-inset flex items-start gap-3 rounded-everyos-md p-3"
          >
            {needsTick ? (
              <input
                type="checkbox"
                aria-label={t(`desktopApps.capabilities.${key}.title` as never, { adapter })}
                checked={approved?.has(permission.capability) ?? false}
                onChange={() => onToggle?.(permission.capability)}
                className="mt-1 size-4 accent-[rgb(var(--everyos-accent))]"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                {t(`desktopApps.capabilities.${key}.title` as never, { adapter })}
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[0.68rem] font-medium",
                    RISK_STYLE[permission.risk],
                  )}
                >
                  {t(`desktopApps.store.risk.${permission.risk}`)}
                </span>
                {permission.granted === false ? (
                  <span className="text-[0.68rem] text-fg-subtle">
                    {t("desktopApps.store.notGranted")}
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs text-fg-muted">
                {t(`desktopApps.capabilities.${key}.description` as never, { adapter })}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A desktop app as the store shows it: what it is, who publishes it, what it may do, and the
 * install, update, open, turn off and uninstall actions. Sensitive and elevated permissions are
 * approved one by one before an install or an update that adds them.
 */
export function DesktopAppDialog({
  listing,
  installation,
  onClose,
  onChanged,
}: {
  listing: DesktopAppListing | null;
  installation: DesktopAppInstallationView | null;
  onClose: () => void;
  /** After an action: the installation as it is now (null once uninstalled). */
  onChanged: (installation: DesktopAppInstallationView | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const canManage = permissions.includes("apps:manage");
  const isAdmin = permissions.includes("settings:manage");
  const name =
    useDesktopApps((state) =>
      installation ? (state.names[installation.appId] ?? installation.name) : null,
    ) ??
    listing?.name ??
    "";
  const appId = listing?.appId ?? installation!.appId;
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notifications, setNotifications] = useState<boolean | null>(null);

  useEffect(() => {
    if (!installation) return;
    let stale = false;
    void api<{ notifications: boolean }>(`/desktop-apps/installed/${appId}/settings`)
      .then((settings) => {
        if (!stale) setNotifications(settings.notifications);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [appId, installation]);

  const granted = new Set(
    (installation?.permissions ?? []).filter((p) => p.granted).map((p) => p.capability),
  );
  // What an install or update must have approved: sensitive and elevated ones not granted yet.
  const offered = listing?.permissions ?? [];
  const needsApproval = new Set(
    offered
      .filter((p) => p.risk !== "standard" && !granted.has(p.capability))
      .map((p) => p.capability),
  );
  const elevatedBlocked = offered.some(
    (p) => p.risk === "elevated" && needsApproval.has(p.capability) && !isAdmin,
  );
  const allApproved = [...needsApproval].every((capability) => approved.has(capability));
  const toggle = (capability: string) =>
    setApproved((current) => {
      const next = new Set(current);
      if (next.has(capability)) next.delete(capability);
      else next.add(capability);
      return next;
    });

  const run = async (action: () => Promise<DesktopAppInstallationView | null>) => {
    setPending(true);
    setError(null);
    try {
      const next = await action();
      await refreshDesktopApps();
      setApproved(new Set());
      onChanged(next);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };
  const install = () =>
    run(() =>
      api<DesktopAppInstallationView>("/desktop-apps/installed", {
        method: "POST",
        body: { registryId: listing!.registry.id, appId, approve: [...approved] },
      }),
    );
  const update = () =>
    run(() =>
      api<DesktopAppInstallationView>(`/desktop-apps/installed/${appId}/update`, {
        method: "POST",
        body: { approve: [...approved] },
      }),
    );
  const setEnabled = (enabled: boolean) =>
    run(() =>
      api<DesktopAppInstallationView>(`/desktop-apps/installed/${appId}`, {
        method: "PATCH",
        body: { enabled },
      }),
    );
  const uninstall = async () => {
    if (
      !(await requestConfirm({
        title: t("desktopApps.store.uninstallTitle", { name }),
        body: t("desktopApps.store.uninstallBody"),
        confirmLabel: t("desktopApps.store.uninstall"),
        danger: true,
      }))
    )
      return;
    // Closes the dialog once it is gone; an error stays visible here.
    await run(() =>
      api(`/desktop-apps/installed/${appId}`, { method: "DELETE", body: { confirm: true } }).then(
        () => null,
      ),
    );
  };
  const toggleNotifications = async (enabled: boolean) => {
    setNotifications(enabled);
    await api(`/desktop-apps/installed/${appId}/settings`, {
      method: "PUT",
      body: { notifications: enabled },
    }).catch((caught: unknown) => {
      setNotifications(!enabled);
      setError(caught);
    });
  };

  const icon = installation
    ? `${installation.runtimeUrl}${installation.icon}`
    : `/api/desktop-apps/catalog/${listing!.registry.id}/${appId}/icon`;
  const kind = installation?.registry?.kind ?? listing?.registry.kind ?? null;
  // The listing may predate an update just made from this dialog.
  const updating = Boolean(
    installation && listing?.updateAvailable && listing.updateAvailable !== installation.version,
  );
  const state = installation?.state ?? null;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={
        <span className="flex items-center gap-3">
          <img src={icon} alt="" className="size-10 rounded-everyos-sm object-contain" />
          <span className="flex flex-col">
            <span>{name}</span>
            <span className="text-xs font-normal text-fg-muted">
              {t("desktopApps.store.by", {
                publisher: listing?.publisher.name ?? installation?.publisher.name ?? "",
              })}
            </span>
          </span>
        </span>
      }
      className="w-[min(94vw,640px)]"
    >
      <div className="flex flex-col gap-4" data-testid="desktop-app-dialog">
        <div className="flex flex-wrap gap-2 text-xs">
          {kind ? (
            <span className="rounded-full bg-[rgb(var(--everyos-accent)/0.15)] px-2 py-0.5 text-[rgb(var(--everyos-accent))]">
              {t(`desktopApps.store.sources.${kind}`)}
            </span>
          ) : null}
          <span className="rounded-full bg-hover/12 px-2 py-0.5 text-fg-muted">
            {t("desktopApps.store.desktopBadge")}
          </span>
          <span className="rounded-full bg-hover/12 px-2 py-0.5 text-fg-muted">
            {t("desktopApps.store.version", {
              version: installation?.version ?? listing?.version ?? "",
            })}
          </span>
          {state && state !== "active" ? (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">
              {t(`desktopApps.store.state.${state}`)}
            </span>
          ) : null}
        </div>
        <p className="whitespace-pre-wrap text-sm text-fg">
          {listing?.description ?? installation?.description}
        </p>
        {listing?.conflict ? <Alert tone="warning">{t("desktopApps.store.conflict")}</Alert> : null}
        {listing?.incompatible ? (
          <Alert tone="warning">
            {t(`desktopApps.store.incompatible.${listing.incompatible}`)}
          </Alert>
        ) : null}
        {listing?.revoked || installation?.state === "revoked" ? (
          <Alert tone="danger">
            {t("desktopApps.store.revoked", {
              reason: listing?.revoked ?? installation?.stateReason ?? "",
            })}
          </Alert>
        ) : null}

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg">{t("desktopApps.store.permissions")}</h3>
          {needsApproval.size && canManage ? (
            <p className="flex items-center gap-2 text-xs text-fg-muted">
              <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
              {t(updating ? "desktopApps.store.approveUpdate" : "desktopApps.store.approve")}
            </p>
          ) : null}
          <PermissionList
            permissions={installation && !updating ? installation.permissions : offered}
            approvable={canManage ? needsApproval : new Set()}
            approved={approved}
            onToggle={toggle}
          />
          {elevatedBlocked && canManage ? (
            <p className="text-xs text-danger">{t("desktopApps.store.elevatedAdmins")}</p>
          ) : null}
        </section>

        {installation &&
        canManage &&
        installation.permissions.some(
          (permission) => permission.capability === "network:outbound" && permission.granted,
        ) ? (
          <NetworkRules appId={appId} />
        ) : null}

        {listing ? (
          <section className="grid gap-x-4 gap-y-1 text-xs text-fg-muted sm:grid-cols-2">
            <span>{t("desktopApps.store.languages", { count: listing.locales.length })}</span>
            <span>{t("desktopApps.store.widgets", { count: listing.widgets })}</span>
            {listing.license ? (
              <span>{t("desktopApps.store.license", { license: listing.license })}</span>
            ) : null}
            {[
              ["homepage", listing.homepage],
              ["source", listing.source],
            ].map(([label, href]) =>
              href ? (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[rgb(var(--everyos-accent))] hover:underline"
                >
                  {t(`desktopApps.store.${label as "homepage" | "source"}`)}
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : null,
            )}
          </section>
        ) : null}

        {listing?.versions.length ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-fg">{t("desktopApps.store.versions")}</summary>
            <ul className="mt-2 flex flex-col gap-2">
              {listing.versions.map((entry) => (
                <li key={entry.version} className="text-xs">
                  <span className="font-medium text-fg">{entry.version}</span>
                  <span className="text-fg-subtle">
                    {" "}
                    · {formatDateTime(entry.publishedAt, i18n.language)}
                  </span>
                  {entry.changelog ? (
                    <p className="mt-0.5 whitespace-pre-wrap text-fg-muted">{entry.changelog}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {installation && notifications !== null ? (
          <label className="flex items-center justify-between gap-3 text-sm text-fg">
            {t("desktopApps.store.notifications")}
            <input
              type="checkbox"
              checked={notifications}
              onChange={(event) => void toggleNotifications(event.target.checked)}
              className="size-4 accent-[rgb(var(--everyos-accent))]"
            />
          </label>
        ) : null}

        <ResourceError error={error} />
        <div className="flex flex-wrap justify-end gap-2">
          {installation && canManage ? (
            <>
              <Button variant="ghost" disabled={pending} onClick={() => void uninstall()}>
                {t("desktopApps.store.uninstall")}
              </Button>
              {state === "active" || state === "disabled" ? (
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => void setEnabled(state !== "active")}
                >
                  {state === "active"
                    ? t("desktopApps.store.disable")
                    : t("desktopApps.store.enable")}
                </Button>
              ) : null}
            </>
          ) : null}
          {installation && updating && canManage ? (
            <Button
              disabled={pending || !allApproved || elevatedBlocked}
              onClick={() => void update()}
            >
              {t("desktopApps.store.updateTo", { version: listing!.updateAvailable })}
            </Button>
          ) : null}
          {installation && state === "active" ? (
            <Button
              onClick={() => {
                desktop.openApp(desktopAppWindowId(appId));
                onClose();
              }}
            >
              <AppWindow className="size-4" aria-hidden />
              {t("desktopApps.store.open")}
            </Button>
          ) : null}
          {!installation && listing && canManage ? (
            <Button
              disabled={
                pending ||
                !allApproved ||
                elevatedBlocked ||
                Boolean(listing.incompatible) ||
                Boolean(listing.revoked)
              }
              onClick={() => void install()}
            >
              {t("desktopApps.store.install")}
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
