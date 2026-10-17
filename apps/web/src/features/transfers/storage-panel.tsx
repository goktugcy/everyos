import type { TransferView } from "@everyos/shared";
import { ArrowDown, ArrowUp, Cloud, FolderOpen, LogOut, Plug, X } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn.ts";
import { errorMessage } from "../../lib/errors.ts";
import { formatBytes } from "../../lib/format.ts";
import { ApiRequestError } from "../../lib/api.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { desktop } from "../../desktop/state/controller.ts";
import { diskRootId } from "@everyos/shared";
import type { AppId } from "../../desktop/apps/types.ts";
import { DiskGlyph, disks, shownVolumes, useLiveDisks, volumeName } from "../disks/disks.tsx";
import { useDriveAccount } from "../drive/drive.ts";
import {
  allTransfers,
  formatEta,
  formatRate,
  isActive,
  transfers as transferActions,
  useTransfers,
  type TransferSummary,
} from "./transfers.ts";

/** A thin ring around an icon: the share already moved, or a spinning arc when unknown. */
export function TransferRing({
  summary,
  size = 22,
  children,
}: {
  summary: TransferSummary;
  size?: number;
  children: ReactNode;
}) {
  const radius = size / 2 - 1.5;
  const circumference = 2 * Math.PI * radius;
  const fraction =
    summary.bytesTotal && summary.bytesTotal > 0
      ? Math.min(1, summary.bytesDone / summary.bytesTotal)
      : null;
  return (
    <span className="relative grid place-items-center" style={{ width: size, height: size }}>
      {summary.active ? (
        <svg
          aria-hidden
          width={size}
          height={size}
          className={cn("absolute inset-0 -rotate-90", fraction === null && "animate-spin")}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth="2"
            className="stroke-current opacity-20"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            className="stroke-accent transition-[stroke-dashoffset] duration-500"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - (fraction ?? 0.25))}
          />
        </svg>
      ) : null}
      {children}
    </span>
  );
}

function errorText(t: TFunction, code: string | null): string {
  if (!code) return t("transfers.failed");
  if (code === "CANCELLED") return t("transfers.cancelled");
  return errorMessage(t, new ApiRequestError(0, code as never, code));
}

function TransferRow({ transfer }: { transfer: TransferView }) {
  const { t, i18n } = useTranslation();
  const active = isActive(transfer);
  const Icon = transfer.direction === "upload" ? ArrowUp : ArrowDown;
  const fraction =
    transfer.bytesTotal && transfer.bytesTotal > 0
      ? Math.min(1, transfer.bytesDone / transfer.bytesTotal)
      : null;
  const eta = formatEta(transfer.etaSeconds, t);
  const sizes =
    transfer.bytesTotal !== null
      ? `${formatBytes(transfer.bytesDone, i18n.language)} / ${formatBytes(transfer.bytesTotal, i18n.language)}`
      : formatBytes(transfer.bytesDone, i18n.language);
  const status =
    transfer.state === "queued"
      ? t("transfers.queued")
      : transfer.state === "running"
        ? [
            sizes,
            transfer.speed > 0
              ? formatRate(transfer.speed, i18n.language, t)
              : t("transfers.starting"),
            eta ? t("transfers.left", { eta }) : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : transfer.state === "done"
          ? `${t("transfers.done")} · ${formatBytes(transfer.bytesTotal ?? transfer.bytesDone, i18n.language)}`
          : transfer.state === "cancelled"
            ? t("transfers.cancelled")
            : errorText(t, transfer.error);
  return (
    <li className="flex flex-col gap-1.5" data-testid="transfer" data-state={transfer.state}>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-full",
            transfer.state === "failed"
              ? "bg-danger/15 text-danger"
              : transfer.state === "done"
                ? "bg-success/15 text-success"
                : "bg-accent/15 text-accent",
          )}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium" title={transfer.name}>
            {transfer.name}
          </span>
          <span className="truncate text-[0.72rem] text-fg-muted" title={transfer.to}>
            {transfer.to}
          </span>
        </span>
        {active ? (
          <button
            type="button"
            className="grid size-6 shrink-0 place-items-center rounded-full text-fg-muted outline-none hover:bg-hover/15 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
            aria-label={t("transfers.cancel")}
            title={t("transfers.cancel")}
            onClick={() => void transferActions.cancel(transfer.id)}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {active ? (
        <div
          className="h-1 overflow-hidden rounded-full bg-hover/15"
          role="progressbar"
          aria-label={transfer.name}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(fraction !== null ? { "aria-valuenow": Math.round(fraction * 100) } : {})}
        >
          <div
            className={cn(
              "h-full rounded-full bg-accent transition-[width] duration-500",
              fraction === null && "w-1/3 animate-pulse",
            )}
            style={fraction !== null ? { width: `${Math.max(2, fraction * 100)}%` } : undefined}
          />
        </div>
      ) : null}
      <span
        className={cn(
          "text-[0.72rem] tabular-nums",
          transfer.state === "failed" ? "text-danger" : "text-fg-muted",
        )}
        data-testid="transfer-status"
      >
        {status}
      </span>
    </li>
  );
}

/** Transfers, plugged-in disks and connected clouds: the menu bar, dock shelf and phone panel. */
export function StoragePanel({
  onNavigate,
  openApp = (appId, appState) =>
    desktop.openApp(appId as AppId, { appState, newInstance: appId === "everyos.files" }),
  extra,
}: {
  onNavigate?: () => void;
  /** Phones open apps full screen instead of in windows. */
  openApp?: (appId: string, appState?: Record<string, unknown>) => void;
  extra?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const canManage = permissions.includes("system:manage");
  const local = useTransfers((state) => state.local);
  const server = useTransfers((state) => state.server);
  const list = useMemo(() => allTransfers({ local, server }), [local, server]);
  const finished = list.some((transfer) => !isActive(transfer));
  const diskList = useLiveDisks((state) => state.list);
  const drive = useDriveAccount((state) => state.view);
  const volumes = useMemo(() => shownVolumes(diskList), [diskList]);
  const go = (action: () => void) => {
    action();
    onNavigate?.();
  };
  return (
    <div className="flex flex-col gap-4" data-testid="storage-panel">
      <section className="flex flex-col gap-2.5">
        <header className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{t("transfers.title")}</h3>
          {finished ? (
            <button
              type="button"
              className="text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => void transferActions.clear()}
            >
              {t("transfers.clear")}
            </button>
          ) : null}
        </header>
        {list.length ? (
          <ul className="flex max-h-72 flex-col gap-3 overflow-y-auto pr-1">
            {list.slice(0, 12).map((transfer) => (
              <TransferRow key={transfer.id} transfer={transfer} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-fg-muted">{t("transfers.none")}</p>
        )}
      </section>
      {permissions.includes("system:read") ? (
        <section className="flex flex-col gap-2 border-t border-line pt-3">
          <header className="flex items-center justify-between">
            <h3 className="font-semibold">{t("transfers.disks")}</h3>
            <button
              type="button"
              className="text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => go(() => openApp("everyos.settings", { section: "disks" }))}
            >
              {t("transfers.settings")}
            </button>
          </header>
          {volumes.length ? (
            <ul className="flex flex-col gap-1.5">
              {volumes.map(({ device, volume }) => (
                <li
                  key={volume.uuid}
                  className="flex items-center gap-2"
                  data-testid="storage-volume"
                  data-volume={volume.uuid}
                >
                  <DiskGlyph size={26} usb={device.transport === "usb"} mounted={volume.managed} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{volumeName(volume, device)}</span>
                    <span className="truncate text-[0.72rem] text-fg-muted">
                      {formatBytes(volume.sizeBytes, i18n.language)} ·{" "}
                      {volume.managed ? t("disks.desktop.mounted") : t("disks.desktop.notMounted")}
                    </span>
                  </span>
                  {volume.managed ? (
                    <>
                      <PanelButton
                        label={t("transfers.open")}
                        onClick={() =>
                          go(() =>
                            openApp("everyos.files", { root: diskRootId(volume.uuid), path: "" }),
                          )
                        }
                      >
                        <FolderOpen className="size-3.5" aria-hidden />
                      </PanelButton>
                      {canManage ? (
                        <PanelButton
                          label={t("disks.eject")}
                          onClick={() => void disks.eject(t, volume, device)}
                        >
                          <LogOut className="size-3.5" aria-hidden />
                        </PanelButton>
                      ) : null}
                    </>
                  ) : canManage ? (
                    <PanelButton
                      label={t("disks.mount")}
                      onClick={() => go(() => disks.askMount(volume.uuid))}
                    >
                      <Plug className="size-3.5" aria-hidden />
                    </PanelButton>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-fg-muted">{t("transfers.noDisks")}</p>
          )}
        </section>
      ) : null}
      {drive?.configured ? (
        <section
          className="flex flex-col gap-2 border-t border-line pt-3"
          data-testid="storage-drive"
        >
          <h3 className="font-semibold">{t("drive.title")}</h3>
          <div className="flex items-center gap-2">
            <span className="grid size-[26px] shrink-0 place-items-center rounded-md bg-accent/15 text-accent">
              <Cloud className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate text-[0.78rem] text-fg-muted">
              {drive.account
                ? drive.account.status === "connected"
                  ? t("drive.connected", { email: drive.account.email })
                  : t("drive.reconnectNeeded")
                : t("drive.notConnected")}
            </span>
            {drive.account?.status === "connected" ? (
              <PanelButton
                label={t("transfers.open")}
                onClick={() =>
                  go(() => openApp("everyos.files", { place: "drive", driveFolder: "root" }))
                }
              >
                <FolderOpen className="size-3.5" aria-hidden />
              </PanelButton>
            ) : (
              <button
                type="button"
                className="shrink-0 text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
                onClick={() => go(() => openApp("everyos.settings", { section: "connections" }))}
              >
                {drive.account ? t("drive.reconnect") : t("drive.connect")}
              </button>
            )}
          </div>
        </section>
      ) : null}
      {extra}
    </div>
  );
}

function PanelButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-md text-fg-muted outline-none hover:bg-hover/15 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
    >
      {children}
    </button>
  );
}
