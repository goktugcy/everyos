import type { TailscaleDetails, TailscaleStatus } from "./schemas/host.ts";

/*
 * Tailscale overview (docs/tailscale.md): this node, remote access to Otuken
 * through Tailscale Serve/Funnel, and warnings worth acting on. Otuken never
 * changes the Tailscale configuration; it only reads and explains it.
 */

export const TAILSCALE_WARNING_KINDS = [
  "not-running",
  "needs-login",
  "key-expiring",
  "key-expired",
  "exit-node-offline",
  "funnel-public",
  "origin-missing",
  "proxy-untrusted",
  "health",
] as const;

export type TailscaleWarningKind = (typeof TAILSCALE_WARNING_KINDS)[number];

export interface TailscaleWarning {
  kind: TailscaleWarningKind;
  severity: "info" | "warning" | "critical";
  params: Record<string, string | number>;
}

export interface TailscaleRemoteAccess {
  /** Port the Otuken API listens on. */
  port: number;
  /** Serve handlers that forward to Otuken. */
  urls: Array<{ url: string; funnel: boolean; originAllowed: boolean }>;
  /** The local proxy (127.0.0.1) is a trusted proxy, so client addresses and HTTPS are detected. */
  proxyTrusted: boolean;
  /** How to publish Otuken on the tailnet when it is not yet published. */
  suggestion: { url: string; command: string } | null;
}

export interface TailscaleOverview {
  status: TailscaleStatus;
  details: TailscaleDetails;
  remoteAccess: TailscaleRemoteAccess;
  warnings: TailscaleWarning[];
  /** The viewer may list the other devices of the tailnet. */
  canSeePeers: boolean;
}
