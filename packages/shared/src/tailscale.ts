import type { TailscaleDetails, TailscaleStatus } from "./schemas/host.ts";

/*
 * Tailscale overview (docs/tailscale.md): this node, remote access to EveryOS
 * through Tailscale Serve/Funnel, and warnings worth acting on. The only change
 * EveryOS makes is its own HTTPS Serve handler, when an administrator turns it on
 * (never Funnel, never other handlers).
 */

/** Why Tailscale Serve could not be turned on for EveryOS. */
export const TAILSCALE_SERVE_REFUSALS = [
  "not-running",
  "https-disabled",
  "port-in-use",
  "funnel",
  "api-not-on-loopback",
] as const;
export type TailscaleServeRefusal = (typeof TAILSCALE_SERVE_REFUSALS)[number];

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
  /** Port the EveryOS API listens on. */
  port: number;
  /** Serve handlers that forward to EveryOS. */
  urls: Array<{ url: string; funnel: boolean; originAllowed: boolean }>;
  /** The local proxy (127.0.0.1) is a trusted proxy, so client addresses and HTTPS are detected. */
  proxyTrusted: boolean;
  /** How to publish EveryOS on the tailnet when it is not yet published. */
  suggestion: { url: string; command: string } | null;
  /** EveryOS's own Serve handler (turned on from EveryOS) answers at this address. */
  managed: string | null;
}

export interface TailscaleOverview {
  status: TailscaleStatus;
  details: TailscaleDetails;
  remoteAccess: TailscaleRemoteAccess;
  warnings: TailscaleWarning[];
  /** The viewer may list the other devices of the tailnet. */
  canSeePeers: boolean;
}
