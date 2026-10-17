import type { DiskDevice, DiskVolume } from "@everyos/shared";
import { FolderOpen, HardDrive, Plug, Usb } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { SudoUnlock } from "../../../features/account/sudo-unlock.tsx";
import {
  diskErrorText,
  disks as diskActions,
  useLiveDisks,
} from "../../../features/disks/disks.tsx";
import { formatBytes } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { Toggle } from "../../menubar/quick-settings.tsx";
import { LoadingBlock, SimulatedBadge } from "../system/parts.tsx";
import { SettingsGroup } from "./group.tsx";

/** Disks of the host: mount extra and USB disks for Files and apps (docs/disks.md). */
export default function DisksSection() {
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const canManage = permissions.includes("system:manage");
  // Kept live by the shell from the `disks` event topic.
  const data = useLiveDisks((state) => state.list);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [remember, setRemember] = useState(true);
  const act = async (uuid: string, request: () => Promise<unknown>) => {
    setBusy(uuid);
    setError(null);
    try {
      await request();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
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
        {device.volumes.map((volume) => (
          <VolumeRow
            key={volume.name}
            device={device}
            volume={volume}
            canManage={canManage}
            busy={busy}
            onMount={(uuid) => void act(uuid, () => diskActions.mount(uuid, remember))}
            onRemember={(uuid, on) => void act(uuid, () => diskActions.mount(uuid, on))}
          />
        ))}
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
            <Toggle label={t("disks.atBootNew")} checked={remember} onCheckedChange={setRemember} />
          </label>
        ) : null}
        {!data ? <LoadingBlock /> : null}
        {error ? (
          <Alert tone="danger" onDismiss={() => setError(null)}>
            {diskErrorText(t, error)}
          </Alert>
        ) : null}
        <SudoUnlock error={error} />
        {data?.disks.filter((device) => !device.system).map(disk)}
        {data && !data.disks.some((device) => !device.system) ? (
          <p className="text-sm text-fg-muted">{t("disks.none")}</p>
        ) : null}
        {data?.remembered.length ? (
          <section className="flex flex-col gap-2" data-testid="remembered-disks">
            <h3 className="text-sm font-semibold">{t("disks.remembered")}</h3>
            <p className="text-xs text-fg-muted">{t("disks.rememberedHint")}</p>
            <ul className="flex flex-col gap-2">
              {data.remembered.map((entry) => (
                <li
                  key={entry.uuid}
                  className="flex items-center gap-3 rounded-everyos-sm bg-hover/5 p-2.5 text-sm"
                >
                  <Usb className="size-4 text-fg-subtle" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{entry.label ?? entry.uuid}</span>
                  {canManage ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void diskActions.forget(t, entry.uuid, entry.label)}
                    >
                      {t("disks.forget")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {data?.disks.some((device) => device.system) ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-fg-muted">{t("disks.systemDisks")}</summary>
            <div className="mt-3 flex flex-col gap-3">
              {data.disks.filter((device) => device.system).map(disk)}
            </div>
          </details>
        ) : null}
      </div>
    </SettingsGroup>
  );
}

function VolumeRow({
  device,
  volume,
  canManage,
  busy,
  onMount,
  onRemember,
}: {
  device: DiskDevice;
  volume: DiskVolume;
  canManage: boolean;
  busy: string | null;
  onMount: (uuid: string) => void;
  onRemember: (uuid: string, on: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const elsewhere = volume.mountpoints.length > 0 && !volume.managed;
  const mountable = !device.system && volume.supported && volume.uuid && !elsewhere;
  const uuid = volume.uuid;
  return (
    <li
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
      {volume.managed && uuid ? (
        <Button size="sm" variant="ghost" onClick={() => diskActions.open(uuid)}>
          <FolderOpen className="size-4" aria-hidden />
          {t("disks.openFiles")}
        </Button>
      ) : null}
      {canManage && volume.managed && uuid ? (
        <>
          <label className="flex items-center gap-2 text-xs">
            {t("disks.atBoot")}
            <Toggle
              label={t("disks.atBoot")}
              checked={volume.persistent}
              disabled={busy !== null}
              onCheckedChange={(on) => onRemember(uuid, on)}
            />
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void diskActions.eject(t, { ...volume, uuid }, device)}
          >
            {t("disks.eject")}
          </Button>
        </>
      ) : null}
      {canManage && mountable && !volume.managed && uuid ? (
        <Button
          size="sm"
          loading={busy === uuid}
          disabled={busy !== null}
          onClick={() => onMount(uuid)}
        >
          <Plug className="size-4" aria-hidden />
          {t("disks.mount")}
        </Button>
      ) : null}
    </li>
  );
}
