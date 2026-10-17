import type { TransferDirection, TransferView } from "@everyos/shared";
import type { TFunction } from "i18next";
import { create } from "zustand";
import { api } from "../../lib/api.ts";

/*
 * Everything moving right now, for the menu bar, the dock shelf, Files and phones: the server's
 * transfers of this person (the `transfers` event topic) and uploads from this browser tab.
 */

interface LocalTransfer extends TransferView {
  abort: (() => void) | null;
}

interface TransfersState {
  server: TransferView[];
  local: LocalTransfer[];
}

export const useTransfers = create<TransfersState>()(() => ({ server: [], local: [] }));

export async function refreshTransfers(): Promise<void> {
  try {
    const { transfers } = await api<{ transfers: TransferView[] }>("/transfers");
    useTransfers.setState({ server: transfers });
  } catch {
    // The next event or reconnect brings the list.
  }
}

/** Newest first: what is moving, then what finished. */
export function allTransfers(state: Pick<TransfersState, "local" | "server">): TransferView[] {
  return [...state.local, ...state.server].sort(
    (a, b) =>
      Number(isActive(b)) - Number(isActive(a)) ||
      (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt),
  );
}

export const isActive = (transfer: TransferView) =>
  transfer.state === "queued" || transfer.state === "running";

/** All running transfers together, for indicators. */
export interface TransferSummary {
  active: number;
  bytesDone: number;
  /** Null when some total is unknown. */
  bytesTotal: number | null;
  speed: number;
  etaSeconds: number | null;
  direction: TransferDirection | "both" | null;
}

export function summarize(transfers: TransferView[]): TransferSummary {
  const active = transfers.filter(isActive);
  const known = active.every((transfer) => transfer.bytesTotal !== null);
  const bytesDone = active.reduce((sum, transfer) => sum + transfer.bytesDone, 0);
  const bytesTotal = known
    ? active.reduce((sum, transfer) => sum + (transfer.bytesTotal ?? 0), 0)
    : null;
  const speed = active.reduce((sum, transfer) => sum + transfer.speed, 0);
  const directions = new Set(active.map((transfer) => transfer.direction));
  return {
    active: active.length,
    bytesDone,
    bytesTotal,
    speed,
    etaSeconds:
      bytesTotal !== null && speed > 1
        ? Math.ceil(Math.max(0, bytesTotal - bytesDone) / speed)
        : null,
    direction: directions.size > 1 ? "both" : ([...directions][0] ?? null),
  };
}

/** The summary of everything in the store (stable while nothing changes). */
export function useTransferSummary(): TransferSummary {
  const local = useTransfers((state) => state.local);
  const server = useTransfers((state) => state.server);
  return summarize([...local, ...server]);
}

/* --------------------------- uploads from this tab --------------------------- */

export interface LocalTransferHandle {
  progress: (loaded: number, total?: number) => void;
  done: () => void;
  fail: (code: string) => void;
}

const samples = new Map<string, { at: number; bytes: number }>();
let ticker: ReturnType<typeof setInterval> | null = null;

function patchLocal(id: string, patch: (transfer: LocalTransfer) => Partial<LocalTransfer>): void {
  useTransfers.setState((state) => ({
    local: state.local.map((transfer) =>
      transfer.id === id ? { ...transfer, ...patch(transfer) } : transfer,
    ),
  }));
}

/** Speed and time left of browser uploads, sampled twice a second like the server does. */
function tick(): void {
  if (ticker) return;
  ticker = setInterval(() => {
    const now = Date.now();
    let running = 0;
    for (const transfer of useTransfers.getState().local) {
      if (transfer.state !== "running") continue;
      running++;
      const sample = samples.get(transfer.id);
      samples.set(transfer.id, { at: now, bytes: transfer.bytesDone });
      if (!sample || now <= sample.at) continue;
      const instant = ((transfer.bytesDone - sample.bytes) * 1000) / (now - sample.at);
      patchLocal(transfer.id, (current) => {
        const speed = current.speed ? current.speed * 0.7 + instant * 0.3 : instant;
        const left =
          current.bytesTotal !== null ? Math.max(0, current.bytesTotal - current.bytesDone) : null;
        return { speed, etaSeconds: left !== null && speed > 1 ? Math.ceil(left / speed) : null };
      });
    }
    if (!running && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }, 500);
}

export const localTransfers = {
  /** Registers an upload made by this tab; `abort` cancels it from the transfer list. */
  start(options: {
    id: string;
    name: string;
    to: string;
    total: number | null;
    direction?: TransferDirection;
    abort?: () => void;
  }): LocalTransferHandle {
    const now = Date.now();
    const transfer: LocalTransfer = {
      id: options.id,
      direction: options.direction ?? "upload",
      name: options.name,
      from: "",
      to: options.to,
      state: "running",
      bytesDone: 0,
      bytesTotal: options.total,
      itemsDone: 0,
      itemsTotal: 1,
      speed: 0,
      etaSeconds: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      abort: options.abort ?? null,
    };
    useTransfers.setState((state) => ({
      // A browser keeps its last few finished uploads in the list.
      local: [
        transfer,
        ...state.local.filter(isActive),
        ...state.local.filter((t) => !isActive(t)).slice(0, 9),
      ],
    }));
    samples.set(transfer.id, { at: now, bytes: 0 });
    tick();
    const finish = (state: "done" | "failed", error: string | null) => {
      samples.delete(transfer.id);
      patchLocal(transfer.id, (current) => ({
        state,
        error,
        speed: 0,
        etaSeconds: null,
        finishedAt: Date.now(),
        itemsDone: state === "done" ? 1 : 0,
        bytesDone: state === "done" ? (current.bytesTotal ?? current.bytesDone) : current.bytesDone,
        abort: null,
      }));
    };
    return {
      progress: (loaded, total) =>
        patchLocal(transfer.id, (current) => ({
          bytesDone: loaded,
          bytesTotal: total ?? current.bytesTotal,
        })),
      done: () => finish("done", null),
      fail: (code) => finish("failed", code),
    };
  },
};

export const transfers = {
  cancel: async (id: string) => {
    const local = useTransfers.getState().local.find((transfer) => transfer.id === id);
    if (local) {
      local.abort?.();
      return;
    }
    await api(`/transfers/${id}/cancel`, { method: "POST", body: {} });
  },
  /** Forgets finished transfers here and on the server. */
  clear: async () => {
    useTransfers.setState((state) => ({ local: state.local.filter(isActive) }));
    await api("/transfers", { method: "DELETE" }).catch(() => undefined);
    await refreshTransfers();
  },
};

/* --------------------------------- formatting --------------------------------- */

/** "12.4 MB": decimal units, matching the speed next to it. */
export function formatAmount(bytes: number, language: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const number = new Intl.NumberFormat(language, {
    maximumFractionDigits: value < 100 && unit > 0 ? 1 : 0,
  }).format(value);
  return `${number} ${units[unit]}`;
}

/** "12.4 MB/s": decimal units, as download managers show them. */
export function formatRate(bytesPerSecond: number, language: string, t: TFunction): string {
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = Math.max(0, bytesPerSecond);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const number = new Intl.NumberFormat(language, {
    maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0,
  }).format(value);
  return t("transfers.rate", { value: `${number} ${units[unit]}` });
}

/** "~48 s", "~3 min", "~1 h 5 min". */
export function formatEta(seconds: number | null, t: TFunction): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return t("transfers.eta.seconds", { count: Math.max(1, Math.round(seconds)) });
  if (seconds < 3600) return t("transfers.eta.minutes", { count: Math.round(seconds / 60) });
  const hours = Math.floor(seconds / 3600);
  return t("transfers.eta.hours", { hours, minutes: Math.round((seconds % 3600) / 60) });
}
