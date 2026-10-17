/*
 * File transfers that run on the server (docs/transfers.md): between Google Drive and EveryOS
 * locations, with live progress for the person who started them.
 */

export const TRANSFER_STATES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

/** `download`: from the cloud to EveryOS; `upload`: from EveryOS (or a browser) to the cloud. */
export const TRANSFER_DIRECTIONS = ["download", "upload"] as const;
export type TransferDirection = (typeof TRANSFER_DIRECTIONS)[number];

/** Where a transfer reads or writes: an EveryOS location or Google Drive. */
export type TransferEndpoint =
  { kind: "files"; root: string; path: string } | { kind: "drive"; id: string };

export interface TransferView {
  id: string;
  direction: TransferDirection;
  /** The top-level file or folder. */
  name: string;
  /** Human-readable source and destination, e.g. "Google Drive › Fotoğraflar". */
  from: string;
  to: string;
  state: TransferState;
  bytesDone: number;
  bytesTotal: number | null;
  itemsDone: number;
  itemsTotal: number | null;
  /** Smoothed bytes per second while running. */
  speed: number;
  /** Seconds left at the current speed; null when unknown. */
  etaSeconds: number | null;
  /** Error code of a failed transfer. */
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** Concurrent transfers per person; more wait in the queue. */
export const MAX_RUNNING_TRANSFERS = 2;
/** Finished transfers kept for the list, per person. */
export const KEPT_FINISHED_TRANSFERS = 20;
