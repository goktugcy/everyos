import { ArrowDownUp, HardDrive } from "lucide-react";
import { Popover } from "radix-ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { shownVolumes, useLiveDisks } from "../../features/disks/disks.tsx";
import { StoragePanel } from "../../features/transfers/storage-panel.tsx";
import {
  formatRate,
  useTransfers,
  useTransferSummary,
} from "../../features/transfers/transfers.ts";
import { cn } from "../../lib/cn.ts";

/**
 * The dock's shelf: like a downloads stack, it appears while something is moving, finished
 * recently or a disk is plugged in, and shows the progress and speed of what is moving.
 */
export function StorageShelf({
  side,
  size,
  vertical,
  tooltip,
}: {
  side: "top" | "left" | "right";
  size: number;
  vertical: boolean;
  tooltip: (label: string, trigger: ReactNode) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const summary = useTransferSummary();
  const transfers = useTransfers((state) => state.local.length + state.server.length);
  const volumes = useLiveDisks((state) => shownVolumes(state.list).length);
  if (!transfers && !volumes && !open) return null;
  const fraction =
    summary.bytesTotal && summary.bytesTotal > 0
      ? Math.min(1, summary.bytesDone / summary.bytesTotal)
      : null;
  const label = summary.active
    ? `${t("transfers.active", { count: summary.active })} · ${formatRate(summary.speed, i18n.language, t)}`
    : t("transfers.storage");
  const Icon = summary.active ? ArrowDownUp : HardDrive;
  return (
    <>
      <span aria-hidden className={cn("bg-line", vertical ? "h-px w-8" : "h-8 w-px")} />
      <Popover.Root open={open} onOpenChange={setOpen}>
        {tooltip(
          label,
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label={label}
              data-testid="dock-storage"
              data-active={summary.active ? "true" : "false"}
              className="relative grid place-items-center rounded-everyos-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
              style={{ width: size, height: size }}
            >
              <span
                className="grid place-items-center rounded-[24%] bg-gradient-to-b from-[#5ac8fa] to-[#0a84ff] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_2px_6px_rgb(0_0_0/0.25)]"
                style={{ width: size * 0.86, height: size * 0.86 }}
              >
                <Icon style={{ width: size * 0.42, height: size * 0.42 }} aria-hidden />
              </span>
              {summary.active ? (
                <>
                  <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[0.6rem] font-bold leading-4 text-white">
                    {summary.active}
                  </span>
                  <span
                    aria-hidden
                    className="absolute inset-x-[14%] bottom-[10%] h-[5px] overflow-hidden rounded-full bg-black/35"
                  >
                    <span
                      className={cn(
                        "block h-full rounded-full bg-white transition-[width] duration-500",
                        fraction === null && "w-1/3 animate-pulse",
                      )}
                      style={
                        fraction !== null ? { width: `${Math.max(4, fraction * 100)}%` } : undefined
                      }
                    />
                  </span>
                </>
              ) : null}
            </button>
          </Popover.Trigger>,
        )}
        <Popover.Portal>
          <Popover.Content
            side={side}
            sideOffset={12}
            collisionPadding={8}
            aria-label={t("transfers.storage")}
            className="glass-strong everyos-enter z-[8000] flex max-h-[min(560px,80vh)] w-[min(340px,calc(100vw-16px))] flex-col overflow-y-auto rounded-everyos-lg p-4 text-sm text-fg"
          >
            <StoragePanel onNavigate={() => setOpen(false)} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}
