import { diskRootId, type DiskDevice, type DiskList, type DiskVolume } from "@everyos/shared";
import { FolderOpen, HardDrive, Plug, Usb } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { SudoUnlock } from "../../../features/account/sudo-unlock.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { Toggle } from "../../menubar/quick-settings.tsx";
import { requestConfirm } from "../../menus/confirm.tsx";
import { desktop } from "../../state/controller.ts";
import { LoadingBlock, ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { SettingsGroup } from "./group.tsx";

/** Disks of the host: mount extra and USB disks for Files and apps (docs/disks.md). */
export default function DisksSection() {
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const canManage = permissions.includes("system:manage");
  const [revision, setRevision] = useState(0);
  const list = useApiResource<DiskList>(
    permissions.includes("system:read") ? "/system/disks" : null,
    10_000,
    revision,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [atBoot, setAtBoot] = useState(true);
  const data = list.data;
  const act = async (uuid: string, request: () => Promise<DiskList>) => {
    setBusy(uuid);
    setError(null);
    try {
      await request();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
      setRevision((n) => n + 1);
    }
  };
  const mount = (uuid: string, persistent: boolean) =>
    act(uuid, () =>
      api<DiskList>("/system/disks/mount", { method: "POST", body: { uuid, persistent } }),
    );
  const eject = async (volume: DiskVolume) => {
    if (!volume.uuid) return;
    const uuid = volume.uuid;
    const ok = await requestConfirm({
      title: t("disks.ejectTitle", { name: volume.label ?? volume.name }),
      body: t("disks.ejectBody"),
      confirmLabel: t("disks.eject"),
    });
    if (ok)
      await act(uuid, () =>
        api<DiskList>("/system/disks/unmount", { method: "POST", body: { uuid, confirm: uuid } }),
      );
  };
  const reason = (caught: unknown) => {
    const details = (caught as { details?: { reason?: string } } | null)?.details;
    return details?.reason
      ? t(`disks.refusals.${details.reason as "busy"}`, { defaultValue: errorMessage(t, caught) })
      : errorMessage(t, caught);
  };
  const disk = (device: DiskDevice) => (
    <article
      key={device.name}
      className="glass-inset flex flex-col gap-3 rounded-everyos-md p-4"
      data-testid="disk"
      data-disk={device.name}
    >
      <header className="flex flex-wrap items-center gap-2">
        {device.transport === "usb" ? (
          <Usb className="size-5 text-fg-muted" aria-hidden />
        ) : (
          <HardDrive className="size-5 text-fg-muted" aria-hidden />
        )}
        <h3 className="font-semibold">{device.model ?? device.name}</h3>
        <span className="text-xs text-fg-muted">
          {device.name} · {formatBytes(device.sizeBytes, i18n.language)}
          {device.transport ? ` · ${device.transport.toUpperCase()}` : ""}
        </span>
        {device.system ? (
          <span className="rounded-full bg-hover/12 px-2 py-0.5 text-[0.7rem] font-semibold text-fg-muted">
            {t("disks.system")}
          </span>
        ) : null}
      </header>
      {device.system ? <p className="text-xs text-fg-muted">{t("disks.systemHint")}</p> : null}
      {!device.volumes.length ? (
        <p className="text-xs text-fg-muted">{t("disks.noVolumes")}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {device.volumes.map((volume) => {
          const elsewhere = volume.mountpoints.length > 0 && !volume.managed;
          const mountable = !device.system && volume.supported && volume.uuid && !elsewhere;
          return (
            <li
              key={volume.name}
              className="flex flex-wrap items-center gap-3 rounded-everyos-sm bg-hover/5 p-2.5"
              data-testid="disk-volume"
              data-volume={volume.name}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {volume.label ?? volume.name}
                  <span className="ml-2 text-xs font-normal text-fg-muted">
                    {volume.fsType ?? t("disks.noFilesystem")} ·{" "}
                    {formatBytes(volume.sizeBytes, i18n.language)}
                  </span>
                </span>
                <span className="truncate text-xs text-fg-muted">
                  {volume.managed
                    ? t(volume.persistent ? "disks.mountedPersistent" : "disks.mountedOnce")
                    : elsewhere
                      ? t("disks.mountedElsewhere", { path: volume.mountpoints.join(", ") })
                      : !volume.supported
                        ? t("disks.unsupported")
                        : t("disks.notMounted")}
                </span>
              </div>
              {volume.managed && volume.uuid ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    desktop.openApp("everyos.files", {
                      newInstance: true,
                      appState: { root: diskRootId(volume.uuid!), path: "" },
                    })
                  }
                >
                  <FolderOpen className="size-4" aria-hidden />
                  {t("disks.openFiles")}
                </Button>
              ) : null}
              {canManage && volume.managed && volume.uuid ? (
                <>
                  <label className="flex items-center gap-2 text-xs">
                    {t("disks.atBoot")}
                    <Toggle
                      label={t("disks.atBoot")}
                      checked={volume.persistent}
                      disabled={busy !== null}
                      onCheckedChange={(on) => void mount(volume.uuid!, on)}
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === volume.uuid}
                    disabled={busy !== null}
                    onClick={() => void eject(volume)}
                  >
                    {t("disks.eject")}
                  </Button>
                </>
              ) : null}
              {canManage && mountable && !volume.managed ? (
                <Button
                  size="sm"
                  loading={busy === volume.uuid}
                  disabled={busy !== null}
                  onClick={() => void mount(volume.uuid!, atBoot)}
                >
                  <Plug className="size-4" aria-hidden />
                  {t("disks.mount")}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </article>
  );
  return (
    <SettingsGroup
      title={t("disks.groupTitle")}
      description={t("disks.hint", { root: data?.mountRoot ?? "/srv/everyos/disks" })}
    >
      <div className="flex flex-col gap-3" data-testid="disks">
        <span>
          <SimulatedBadge source={data?.source} />
        </span>
        {canManage ? (
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="flex flex-col">
              {t("disks.atBootNew")}
              <span className="text-xs text-fg-muted">{t("disks.atBootHint")}</span>
            </span>
            <Toggle label={t("disks.atBootNew")} checked={atBoot} onCheckedChange={setAtBoot} />
          </label>
        ) : null}
        {list.loading && !data ? <LoadingBlock /> : null}
        <ResourceError error={list.error} />
        {error ? (
          <Alert tone="danger" onDismiss={() => setError(null)}>
            {reason(error)}
          </Alert>
        ) : null}
        <SudoUnlock error={error} />
        {data?.disks.filter((device) => !device.system).map(disk)}
        {data?.disks.some((device) => device.system) ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-fg-muted">{t("disks.systemDisks")}</summary>
            <div className="mt-3 flex flex-col gap-3">
              {data.disks.filter((device) => device.system).map(disk)}
            </div>
          </details>
        ) : null}
        {data && !data.disks.some((device) => !device.system) ? (
          <p className="text-sm text-fg-muted">{t("disks.none")}</p>
        ) : null}
      </div>
    </SettingsGroup>
  );
}
