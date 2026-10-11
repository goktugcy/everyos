/*
 * Zod-free terminal contracts (docs/terminal.md). The browser talks to the API
 * over a WebSocket; the agent runs the shell in a pseudo-terminal as the
 * configured (non-root by default) user.
 */

export const TERMINAL_DISABLED_REASONS = [
  "not-configured",
  "user-missing",
  "root-refused",
  "python-missing",
] as const;

export type TerminalDisabledReason = (typeof TERMINAL_DISABLED_REASONS)[number];

export type TerminalStatus =
  | { enabled: true; user: string; shell: string }
  | { enabled: false; reason: TerminalDisabledReason };

export interface TerminalSessionView {
  id: string;
  userId: string;
  username: string;
  /** Linux account the shell runs as. */
  account: string;
  startedAt: number;
  lastInputAt: number;
  /** A browser is connected right now. */
  attached: boolean;
}

/** Messages the server sends as WebSocket text frames (output arrives as binary frames). */
export type TerminalServerMessage =
  | { type: "ready"; sessionId: string; account: string; shell: string; resumed: boolean }
  | {
      type: "exit";
      reason: "exited" | "idle" | "closed" | "revoked" | "error";
      code: number | null;
    };

/** Control messages from the browser (input arrives as binary frames). */
export type TerminalClientMessage = { type: "resize"; cols: number; rows: number };
