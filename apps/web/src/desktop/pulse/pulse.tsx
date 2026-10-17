import type { BackupJobView, UpdateJobView } from "@everyos/shared";
import { ArrowDownUp, EyeOff, Inbox, LayoutDashboard, Settings2, Unplug, Usb } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLiveMetrics, useLiveMetricsSubscription } from "../../features/metrics/live-metrics.ts";
import { shownVolumes, useLiveDisks, volumeName } from "../../features/disks/disks.tsx";
import { StoragePanel } from "../../features/transfers/storage-panel.tsx";
import {
  formatEta,
  formatRate,
  isActive,
  useTransfers,
  useTransferSummary,
} from "../../features/transfers/transfers.ts";
import { api } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { formatPercent } from "../../lib/format.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { FILES_DRAG_TYPE } from "../apps/files/lib.ts";
import { ContextMenuArea } from "../menus/menus.tsx";
import type { MenuEntry } from "../menus/menu-model.ts";
import { unreadTotal, useNotifications } from "../notifications/store.ts";
import { desktop } from "../state/controller.ts";
import { updatePreference, usePreferences } from "../state/preferences-store.ts";
import { PulseDashboard } from "./dashboard.tsx";
import { MATRIX_COLS } from "./pulse-lib.ts";
import { PulseMatrix, type MatrixMode } from "./pulse-matrix.tsx";
import { PulseShelf } from "./shelf.tsx";

type Tab = "home" | "shelf" | "transfers";

/** How long the pulse names a disk that was plugged in or removed. */
const DISK_MESSAGE_MS = 5_000;

interface DiskMessage {
  kind: "attached" | "detached";
  /** The disk's name, plus how many more came or went with it. */
  name: string;
  at: number;
}

/** A disk that just came or went (not the disks present when the shell opened). */
function useDiskMessage(): DiskMessage | null {
  const list = useLiveDisks((state) => state.list);
  const known = useRef<Map<string, string> | null>(null);
  const [message, setMessage] = useState<DiskMessage | null>(null);
  useEffect(() => {
    if (!list) return;
    const present = new Map(
      shownVolumes(list).map((entry) => [
        entry.volume.uuid,
        volumeName(entry.volume, entry.device),
      ]),
    );
    const before = known.current;
    known.current = present;
    if (!before) return;
    const added = [...present].filter(([uuid]) => !before.has(uuid)).map(([, name]) => name);
    const removed = [...before].filter(([uuid]) => !present.has(uuid)).map(([, name]) => name);
    const names = added.length ? added : removed;
    if (!names.length) return;
    setMessage({
      kind: added.length ? "attached" : "detached",
      name: names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]!,
      at: Date.now(),
    });
  }, [list]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), DISK_MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);
  return message;
}

const HOVER_OPEN_MS = 160;
const HOVER_CLOSE_MS = 320;

const isFileDrag = (event: DragEvent) => {
  const types = [...(event.dataTransfer?.types ?? [])];
  return types.includes("Files") || types.includes(FILES_DRAG_TYPE);
};

/** Running backup or update jobs, polled lightly (faster while one runs). */
function useActivity(): { backup: BackupJobView | null; update: UpdateJobView | null } {
  const permissions = usePermissions();
  const canBackups = permissions.includes("backups:manage");
  const canUpdates = permissions.includes("system:read");
  const [state, setState] = useState<{
    backup: BackupJobView | null;
    update: UpdateJobView | null;
  }>({ backup: null, update: null });
  const busy = state.backup !== null || state.update !== null;
  useEffect(() => {
    if (!canBackups && !canUpdates) return;
    let cancelled = false;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      const [backup, update] = await Promise.all([
        canBackups
          ? api<{ job: BackupJobView | null }>("/backups/job")
              .then((r) => r.job)
              .catch(() => null)
          : null,
        canUpdates
          ? api<{ jobs: UpdateJobView[] }>("/updates/jobs")
              .then((r) => r.jobs.find((job) => job.status === "running") ?? null)
              .catch(() => null)
          : null,
      ]);
      if (!cancelled) setState({ backup, update });
    };
    void poll();
    const timer = setInterval(() => void poll(), busy ? 2_000 : 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [canBackups, canUpdates, busy]);
  return state;
}

/** The last CPU readings (percent, oldest first) for the dot matrix. */
function useCpuHistory(enabled: boolean): number[] {
  useLiveMetricsSubscription(enabled);
  const points = useLiveMetrics((state) => state.points);
  return useMemo(
    () =>
      points
        .slice(-MATRIX_COLS)
        .map((point) => point.cpuPercent)
        .filter((value): value is number => typeof value === "number"),
    [points],
  );
}

/**
 * The pulse (docs/pulse.md): a dot matrix in the middle of the menu bar that
 * shows the server's heartbeat (CPU history), lights up while a job runs and
 * turns into a drop target while files are dragged. It opens a panel with a
 * dashboard (calendar, system, running jobs) and a shelf for files, on hover
 * or click; it can be hidden in the settings or from its context menu.
 */
export function Pulse() {
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const openOnHover = usePreferences((state) => state.pulse.openOnHover);
  const shelfCount = usePreferences((state) => state.pulse.shelf.length);
  const muted = usePreferences((state) => state.notifications.mutedCategories);
  const unread = useNotifications((state) => unreadTotal(state.unread, muted));
  const canFiles = permissions.includes("files:read");
  const canSystem = permissions.includes("system:read");
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activity = useActivity();
  const cpu = useCpuHistory(canSystem);
  const transfer = useTransferSummary();
  const localTransfers = useTransfers((state) => state.local);
  const serverTransfers = useTransfers((state) => state.server);
  const transfers = useMemo(
    () => [...localTransfers, ...serverTransfers].filter(isActive),
    [localTransfers, serverTransfers],
  );
  const diskMessage = useDiskMessage();
  const fraction =
    transfer.bytesTotal && transfer.bytesTotal > 0
      ? Math.min(1, transfer.bytesDone / transfer.bytesTotal)
      : null;
  // A transfer of unknown size shows its activity with the sweeping light.
  const busy =
    activity.backup !== null ||
    activity.update !== null ||
    (transfer.active > 0 && fraction === null);

  const mode: MatrixMode = useMemo(
    () =>
      dragging
        ? { kind: "drop" }
        : transfer.active > 0
          ? { kind: "transfer", fraction, direction: transfer.direction ?? "download" }
          : canSystem && cpu.length > 0
            ? { kind: "graph", values: cpu }
            : { kind: "idle" },
    [dragging, transfer.active, transfer.direction, fraction, canSystem, cpu],
  );

  // The dots sit in the free middle of the menu bar: centred when they fit there, moved aside
  // when long app names or many modules take the room, and hidden only when they do not fit.
  const [shift, setShift] = useState<number | null>(0);
  useEffect(() => {
    const check = () => {
      const width = triggerRef.current?.offsetWidth;
      if (!width) return;
      const right =
        document.querySelector("[data-menubar-right]")?.getBoundingClientRect().left ??
        window.innerWidth;
      const left = [
        ...document.querySelectorAll(
          '[data-testid="menubar-app"],[data-testid="connection-status"]',
        ),
      ].reduce((edge, element) => Math.max(edge, element.getBoundingClientRect().right), 0);
      const low = left + 8;
      const high = right - 8;
      if (high - low < width) {
        setShift(null);
        return;
      }
      const middle = window.innerWidth / 2;
      const centre = Math.min(Math.max(middle, low + width / 2), high - width / 2);
      setShift(Math.round(centre - middle));
    };
    check();
    const observer = new ResizeObserver(check);
    for (const element of document.querySelectorAll(
      '[data-menubar-right],[data-testid="menubar-app"]',
    ))
      observer.observe(element);
    window.addEventListener("resize", check);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", check);
    };
  }, []);
  const crowded = shift === null;

  const close = useCallback((restoreFocus = false) => {
    clearTimeout(hoverTimer.current);
    setOpen(false);
    setPinned(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Escape and clicks elsewhere close a panel that was opened deliberately.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      // Menus and dialogs opened from the panel live in portals.
      if ((target as Element).closest?.("[data-radix-popper-content-wrapper],[role=dialog]"))
        return;
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  // Dragging files anywhere turns the dots into a drop target.
  useEffect(() => {
    if (!canFiles) return;
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      depth++;
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const end = () => {
      depth = 0;
      setDragging(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", end);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", end);
      window.removeEventListener("dragend", end);
    };
  }, [canFiles]);

  const show = (next: Tab, pin: boolean) => {
    clearTimeout(hoverTimer.current);
    setTab(next);
    setOpen(true);
    if (pin) setPinned(true);
  };

  const hide = () => {
    updatePreference("pulse", (doc) => ({ ...doc, enabled: false }));
  };

  const menu = (): MenuEntry[] => [
    {
      kind: "item",
      id: "home",
      label: t("pulse.tabs.home"),
      icon: <LayoutDashboard />,
      onSelect: () => show("home", true),
    },
    ...(canFiles
      ? [
          {
            kind: "item" as const,
            id: "shelf",
            label: t("pulse.tabs.shelf"),
            icon: <Inbox />,
            onSelect: () => show("shelf", true),
          },
        ]
      : []),
    ...(canFiles || canSystem
      ? [
          {
            kind: "item" as const,
            id: "transfers",
            label: t("pulse.tabs.transfers"),
            icon: <ArrowDownUp />,
            onSelect: () => show("transfers", true),
          },
        ]
      : []),
    { kind: "separator", id: "s" },
    {
      kind: "item",
      id: "settings",
      label: t("pulse.settings"),
      icon: <Settings2 />,
      onSelect: () => desktop.openSettings("desktop"),
    },
    { kind: "item", id: "hide", label: t("pulse.hide"), icon: <EyeOff />, onSelect: hide },
  ];

  const latest = cpu.at(-1);
  const eta = formatEta(transfer.etaSeconds, t);
  const moving =
    transfer.active > 0
      ? [
          transfer.active === 1 && transfers[0]
            ? transfers[0].name
            : t("transfers.active", { count: transfer.active }),
          transfer.speed > 0 ? formatRate(transfer.speed, i18n.language, t) : null,
          eta ? t("transfers.left", { eta }) : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
  const status = [
    moving,
    busy && !moving ? t("pulse.working") : null,
    canSystem && latest !== undefined
      ? t("pulse.cpu", { value: formatPercent(latest, i18n.language) })
      : null,
    unread > 0 ? t("pulse.unread", { count: unread }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label={t("pulse.label")}
      data-testid="pulse"
      data-open={open}
      data-dragging={dragging}
      className="pointer-events-none fixed inset-x-0 top-0 z-[72] flex flex-col items-center"
      onMouseEnter={() => {
        clearTimeout(hoverTimer.current);
        if (!open && openOnHover)
          hoverTimer.current = setTimeout(() => show(tab, false), HOVER_OPEN_MS);
      }}
      onMouseLeave={() => {
        clearTimeout(hoverTimer.current);
        if (open && !pinned) hoverTimer.current = setTimeout(() => close(), HOVER_CLOSE_MS);
      }}
      onDragEnter={(event) => {
        if (!canFiles || !isFileDrag(event.nativeEvent)) return;
        event.preventDefault();
        show("shelf", true);
      }}
      onDragOver={(event) => {
        if (canFiles && isFileDrag(event.nativeEvent)) event.preventDefault();
      }}
      onDrop={(event) => {
        // A drop anywhere on the open shelf panel counts as a drop on the shelf.
        const shelf = rootRef.current?.querySelector('[data-testid="pulse-shelf"]');
        if (!shelf || shelf.contains(event.target as Node) || !isFileDrag(event.nativeEvent))
          return;
        event.preventDefault();
        shelf.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: event.nativeEvent.dataTransfer,
          }),
        );
      }}
    >
      <div
        className="flex h-[var(--everyos-menubar-height)] items-center"
        style={shift ? { transform: `translateX(${shift}px)` } : undefined}
      >
        <ContextMenuArea entries={menu}>
          <button
            ref={triggerRef}
            type="button"
            aria-label={t("pulse.open")}
            aria-expanded={open}
            title={status || t("pulse.label")}
            data-testid="pulse-trigger"
            data-open={open}
            data-mode={mode.kind}
            data-crowded={crowded && !open ? "true" : undefined}
            onClick={() => (open ? close() : show(tab, true))}
            className={cn(
              "pointer-events-auto relative flex h-[32px] items-center rounded-full px-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
              open || dragging ? "bg-hover/15" : "hover:bg-hover/10",
              crowded && !open && !dragging && "pointer-events-none invisible",
            )}
          >
            {/* A disk that came or went is named for a moment; the pill keeps its size. */}
            <span className={cn(diskMessage && !dragging && "invisible")}>
              <PulseMatrix mode={mode} busy={busy} />
            </span>
            {diskMessage && !dragging ? (
              <span
                key={diskMessage.at}
                role="status"
                data-testid="pulse-message"
                data-kind={diskMessage.kind}
                className="everyos-enter absolute inset-0 flex items-center gap-2 px-3.5 text-left"
              >
                {diskMessage.kind === "attached" ? (
                  <Usb className="size-4 shrink-0 text-accent" aria-hidden />
                ) : (
                  <Unplug className="size-4 shrink-0 text-fg-muted" aria-hidden />
                )}
                <span className="flex min-w-0 flex-col leading-[1.15]">
                  <span className="text-[0.7rem] font-semibold">
                    {t(`pulse.disk.${diskMessage.kind}`)}
                  </span>
                  <span className="truncate text-[0.66rem] text-fg-muted">{diskMessage.name}</span>
                </span>
              </span>
            ) : null}
            {unread > 0 ? (
              <span
                className="absolute -right-0.5 top-1/2 size-[7px] -translate-y-1/2 rounded-full bg-[rgb(var(--everyos-accent))] shadow-[0_0_8px_rgb(var(--everyos-accent)/0.9)]"
                aria-hidden
              />
            ) : null}
          </button>
        </ContextMenuArea>
      </div>

      {open ? (
        <div
          className="glass-strong everyos-enter pointer-events-auto mt-1.5 flex h-[296px] w-[min(700px,calc(100vw-24px))] flex-col rounded-everyos-lg p-4 text-fg"
          data-testid="pulse-panel"
        >
          <div className="mb-3 flex items-center gap-2">
            <div role="tablist" aria-label={t("pulse.label")} className="flex gap-1">
              {(
                [
                  "home",
                  ...(canFiles ? (["shelf"] as const) : []),
                  ...(canFiles || canSystem ? (["transfers"] as const) : []),
                ] as Tab[]
              ).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  data-testid={`pulse-tab-${id}`}
                  onClick={() => {
                    setTab(id);
                    setPinned(true);
                  }}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-full px-3 text-[0.78rem] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                    tab === id ? "bg-hover/15 text-fg" : "text-fg-muted hover:bg-hover/10",
                  )}
                >
                  {id === "home" ? (
                    <LayoutDashboard className="size-3.5" aria-hidden />
                  ) : id === "shelf" ? (
                    <Inbox className="size-3.5" aria-hidden />
                  ) : (
                    <ArrowDownUp className="size-3.5" aria-hidden />
                  )}
                  {t(`pulse.tabs.${id}`)}
                  {id === "shelf" && shelfCount > 0 ? (
                    <span className="rounded-full bg-hover/15 px-1.5 text-[0.65rem] tabular-nums">
                      {shelfCount}
                    </span>
                  ) : null}
                  {id === "transfers" && transfer.active > 0 ? (
                    <span className="rounded-full bg-accent/20 px-1.5 text-[0.65rem] tabular-nums text-accent">
                      {transfer.active}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="ml-auto flex gap-1">
              <button
                type="button"
                aria-label={t("pulse.settings")}
                title={t("pulse.settings")}
                onClick={() => {
                  close();
                  desktop.openSettings("desktop");
                }}
                className="grid size-7 place-items-center rounded-full text-fg-muted outline-none hover:bg-hover/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Settings2 className="size-4" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={t("pulse.hide")}
                title={t("pulse.hide")}
                onClick={hide}
                className="grid size-7 place-items-center rounded-full text-fg-muted outline-none hover:bg-hover/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
              >
                <EyeOff className="size-4" aria-hidden />
              </button>
            </div>
          </div>
          <div role="tabpanel" className="min-h-0 flex-1">
            {tab === "shelf" && canFiles ? (
              <PulseShelf />
            ) : tab === "transfers" ? (
              <div className="h-full overflow-y-auto pr-1" data-testid="pulse-transfers">
                <StoragePanel onNavigate={() => close()} />
              </div>
            ) : (
              <PulseDashboard backup={activity.backup} update={activity.update} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
