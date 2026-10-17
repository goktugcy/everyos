import { ArrowDownUp, HardDrive } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StoragePanel, TransferRing } from "../../features/transfers/storage-panel.tsx";
import {
  formatRate,
  useTransfers,
  useTransferSummary,
} from "../../features/transfers/transfers.ts";
import { shownVolumes, useLiveDisks } from "../../features/disks/disks.tsx";
import { useDriveAccount } from "../../features/drive/drive.ts";
import { useMediaQuery } from "../../lib/use-media-query.ts";
import { usePreferences } from "../state/preferences-store.ts";
import { cn } from "../../lib/cn.ts";
import { menubarButton } from "./menubar-button.ts";

/** Disks and transfers: a quiet icon that shows a progress ring and the speed while busy. */
export function StorageModule() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const summary = useTransferSummary();
  const listed = useTransfers((state) => state.local.length + state.server.length);
  const volumes = useLiveDisks((state) => shownVolumes(state.list).length);
  const drive = useDriveAccount(
    (state) => state.view?.account !== null && state.view?.account !== undefined,
  );
  // The pulse shows the progress in the middle of the menu bar; then only the ring stays here.
  const pulse = usePreferences((state) => state.pulse.enabled);
  const wide = useMediaQuery("(min-width: 1100px)");
  // Nothing plugged in, connected or moving: the module takes no room.
  if (!summary.active && !listed && !volumes && !drive && !open) return null;
  const Icon = summary.active ? ArrowDownUp : HardDrive;
  const label = summary.active
    ? `${t("transfers.active", { count: summary.active })} · ${formatRate(summary.speed, i18n.language, t)}`
    : t("transfers.storage");
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={cn(menubarButton, summary.active && "text-accent")}
        aria-label={label}
        title={label}
        data-testid="menubar-storage"
        data-active={summary.active ? "true" : "false"}
      >
        <TransferRing summary={summary} size={21}>
          <Icon aria-hidden className="!size-[13px]" />
        </TransferRing>
        {summary.active && !(pulse && wide) ? (
          <span className="hidden text-[0.75rem] tabular-nums md:inline">
            {formatRate(summary.speed, i18n.language, t)}
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label={t("transfers.storage")}
          className="glass-strong everyos-enter z-[8000] flex max-h-[min(560px,80vh)] w-[min(340px,calc(100vw-16px))] flex-col overflow-y-auto rounded-everyos-lg p-4 text-sm text-fg"
        >
          <StoragePanel onNavigate={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
