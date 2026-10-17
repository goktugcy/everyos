import type { DiskDevice, DiskList, DiskVolume } from "@everyos/shared";
import { diskRootId } from "@everyos/shared";
import type { TFunction } from "i18next";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { api } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { errorMessage } from "../../lib/errors.ts";
import { formatBytes } from "../../lib/format.ts";
import { subscribeTopic } from "../../lib/event-stream.ts";
import { requestConfirm } from "../../desktop/menus/confirm.tsx";
import { desktop } from "../../desktop/state/controller.ts";
import { SudoUnlock } from "../account/sudo-unlock.tsx";

/*
 * The host's disks for the whole shell (docs/disks.md): one live listing from the `disks` event
 * topic feeds the desktop icons, Files, the menu bar, the dock shelf and Settings › Disks.
 */

interface LiveDisksState {
  list: DiskList | null;
}

export const useLiveDisks = create<LiveDisksState>()(() => ({ list: null }));

/** A volume EveryOS can show: on a disk without system mounts, with a known filesystem. */
export interface ShownVolume {
  device: DiskDevice;
  volume: DiskVolume & { uuid: string };
}

export function shownVolumes(list: DiskList | null): ShownVolume[] {
  return (list?.disks ?? []).flatMap((device) =>
    device.system
      ? []
      : device.volumes.flatMap((volume) =>
          volume.uuid && volume.supported && (!volume.mountpoints.length || volume.managed)
            ? [{ device, volume: volume as ShownVolume["volume"] }]
            : [],
        ),
  );
}

export function volumeName(volume: DiskVolume, device?: DiskDevice): string {
  return volume.label ?? device?.model ?? volume.name;
}

async function refresh(): Promise<void> {
  try {
    useLiveDisks.setState({ list: await api<DiskList>("/system/disks") });
  } catch {
    // The next event or reconnect brings the listing.
  }
}

/** Keeps the shared listing live while enabled (needs `system:read`). */
export function useLiveDisksStream(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribeTopic("disks", {
      // A reconnect may have missed a disk coming or going.
      ready: () => void refresh(),
      events: {
        "disks.change": (data) => useLiveDisks.setState({ list: data as DiskList }),
      },
    });
    return () => {
      unsubscribe();
      useLiveDisks.setState({ list: null });
    };
  }, [enabled]);
}

type DiskDialogState =
  { kind: "idle" } | { kind: "mount"; uuid: string } | { kind: "error"; error: unknown };

const useDiskDialog = create<{ state: DiskDialogState }>()(() => ({
  state: { kind: "idle" },
}));

const keep = (list: DiskList) => {
  useLiveDisks.setState({ list });
  return list;
};

export const disks = {
  /** Opens the mount dialog for a plugged-in volume. */
  askMount: (uuid: string) => useDiskDialog.setState({ state: { kind: "mount", uuid } }),
  mount: async (uuid: string, persistent: boolean) =>
    keep(
      await api<DiskList>("/system/disks/mount", { method: "POST", body: { uuid, persistent } }),
    ),
  /** Asks, then unmounts; failures are shown in a dialog. */
  eject: async (t: TFunction, volume: DiskVolume & { uuid: string }, device?: DiskDevice) => {
    const ok = await requestConfirm({
      title: t("disks.ejectTitle", { name: volumeName(volume, device) }),
      body: t("disks.ejectBody"),
      confirmLabel: t("disks.eject"),
    });
    if (!ok) return;
    try {
      keep(
        await api<DiskList>("/system/disks/unmount", {
          method: "POST",
          body: { uuid: volume.uuid, confirm: volume.uuid },
        }),
      );
    } catch (error) {
      useDiskDialog.setState({ state: { kind: "error", error } });
    }
  },
  /** Changes whether a mounted volume is mounted whenever it is plugged in. */
  remember: async (uuid: string, persistent: boolean) => {
    try {
      await disks.mount(uuid, persistent);
    } catch (error) {
      useDiskDialog.setState({ state: { kind: "error", error } });
    }
  },
  forget: async (t: TFunction, uuid: string, label: string | null) => {
    const ok = await requestConfirm({
      title: t("disks.forgetTitle", { name: label ?? uuid }),
      body: t("disks.forgetBody"),
      confirmLabel: t("disks.forget"),
    });
    if (!ok) return;
    try {
      keep(
        await api<DiskList>("/system/disks/unmount", {
          method: "POST",
          body: { uuid, confirm: uuid },
        }),
      );
    } catch (error) {
      useDiskDialog.setState({ state: { kind: "error", error } });
    }
  },
  open: (uuid: string) =>
    desktop.openApp("everyos.files", {
      newInstance: true,
      appState: { root: diskRootId(uuid), path: "" },
    }),
};

/** Why a disk action failed, with the refusal reason when the agent gave one. */
export function diskErrorText(t: TFunction, error: unknown): string {
  const reason = (error as { details?: { reason?: string } } | null)?.details?.reason;
  return reason
    ? t(`disks.refusals.${reason as "busy"}`, { defaultValue: errorMessage(t, error) })
    : errorMessage(t, error);
}

/** The mount dialog and disk errors, mounted once by each shell. */
export function DiskDialogHost() {
  const { t } = useTranslation();
  const state = useDiskDialog((store) => store.state);
  const close = () => useDiskDialog.setState({ state: { kind: "idle" } });
  if (state.kind === "mount") return <MountDialog uuid={state.uuid} onClose={close} />;
  if (state.kind === "error")
    return (
      <Dialog open onOpenChange={(open) => !open && close()} title={t("disks.title")}>
        <div className="flex flex-col gap-3 px-6 py-5">
          <Alert tone="danger">{diskErrorText(t, state.error)}</Alert>
          <SudoUnlock error={state.error} />
          <div className="flex justify-end">
            <Button variant="ghost" onClick={close}>
              {t("common.close")}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  return null;
}

function MountDialog({ uuid, onClose }: { uuid: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const list = useLiveDisks((state) => state.list);
  const shown = shownVolumes(list).find((entry) => entry.volume.uuid === uuid);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The disk was unplugged or mounted elsewhere meanwhile.
  useEffect(() => {
    if (list && (!shown || shown.volume.managed)) onClose();
  }, [list, shown, onClose]);
  if (!shown) return null;
  const name = volumeName(shown.volume, shown.device);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await disks.mount(uuid, remember);
      onClose();
      disks.open(uuid);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("disks.mountDialog.title", { name })}
    >
      <form
        className="flex flex-col gap-4 px-6 py-5"
        onSubmit={(event) => void submit(event)}
        data-testid="disk-mount-dialog"
      >
        <div className="flex items-center gap-3">
          <DiskGlyph size={48} usb={shown.device.transport === "usb"} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-semibold">{name}</span>
            <span className="text-xs text-fg-muted">
              {shown.volume.fsType} · {formatBytes(shown.volume.sizeBytes, i18n.language)}
              {shown.device.model && shown.device.model !== name ? ` · ${shown.device.model}` : ""}
            </span>
          </div>
        </div>
        <p className="text-sm text-fg-muted">
          {t("disks.mountDialog.body", { root: list?.mountRoot ?? "/srv/everyos/disks" })}
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 accent-[rgb(var(--everyos-accent))]"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span className="flex flex-col">
            {t("disks.mountDialog.remember")}
            <span className="text-xs text-fg-muted">{t("disks.mountDialog.rememberHint")}</span>
          </span>
        </label>
        {error ? <Alert tone="danger">{diskErrorText(t, error)}</Alert> : null}
        <SudoUnlock error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={busy}>
            {t("disks.mount")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** An external drive, drawn to sit with app and folder icons; dimmed while not mounted. */
export function DiskGlyph({
  size,
  usb = false,
  mounted = true,
  className,
}: {
  size: number;
  usb?: boolean;
  mounted?: boolean;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      // Cropped close to the drive, so it is as large as app and folder icons.
      viewBox="3 7 58 52"
      aria-hidden
      className={cn("drop-shadow-[0_2px_3px_rgb(0_0_0/0.25)]", !mounted && "opacity-60", className)}
    >
      <defs>
        <linearGradient id="everyos-disk-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f4f5f7" />
          <stop offset="1" stopColor="#c9ced6" />
        </linearGradient>
        <linearGradient id="everyos-disk-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9aa3ad" />
          <stop offset="1" stopColor="#6f7882" />
        </linearGradient>
      </defs>
      <rect x="6" y="16" width="52" height="34" rx="7" fill="url(#everyos-disk-body)" />
      <rect x="6" y="38" width="52" height="12" rx="6" fill="url(#everyos-disk-face)" />
      <rect x="6" y="36" width="52" height="4" fill="url(#everyos-disk-face)" />
      <circle cx="49" cy="44" r="2.2" fill={mounted ? "#34c759" : "#b0b6be"} />
      <rect x="12" y="43" width="18" height="2" rx="1" fill="#e6e9ee" opacity="0.7" />
      {usb ? (
        <g transform="translate(22 20)" fill="#7b8794">
          <rect x="8" y="0" width="4" height="12" rx="1" />
          <path d="M10 0 l-3.5 4 h7 z" />
          <circle cx="10" cy="13" r="2.4" />
          <rect x="3" y="5" width="2" height="5" rx="1" />
          <rect x="15" y="4" width="3" height="3" rx="0.5" />
        </g>
      ) : null}
    </svg>
  );
}
