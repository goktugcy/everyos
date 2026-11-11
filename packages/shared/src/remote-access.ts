export const REMOTE_ACCESS_PROVIDERS = ["tailscale", "netbird"] as const;
export type RemoteAccessProviderId = (typeof REMOTE_ACCESS_PROVIDERS)[number];

export interface RemoteAccessSettings {
  managementUrl: string | null;
  acceptDNS: boolean;
  acceptRoutes: boolean;
}
export interface RemoteAccessNode {
  provider: RemoteAccessProviderId;
  source: "host" | "simulated";
  installed: boolean;
  available: boolean;
  reason: "not-installed" | "daemon-unavailable" | "permission-denied" | "unsupported" | null;
  state: "connected" | "connecting" | "disconnected" | "needs-login" | "unknown";
  version: string | null;
  hostName: string | null;
  addresses: string[];
  managementUrl: string | null;
  dnsEnabled: boolean | null;
  acceptsRoutes: boolean | null;
  routes: string[];
  defaultRoute: boolean | null;
  routeVisibility: boolean;
  peers: { total: number; online: number };
  installationSupported: boolean;
}
export interface RemoteAccessPeer {
  name: string | null;
  addresses: string[];
  online: boolean | null;
  connection: "direct" | "relay" | "idle" | "unknown";
  lastSeen: number | null;
  rxBytes: number;
  txBytes: number;
}
export interface RemoteAccessConflict {
  kind: "multiple-active" | "dns" | "subnet" | "exit-node" | "route-policy" | "visibility";
  severity: "info" | "warning" | "critical";
  providers: RemoteAccessProviderId[];
  routes: string[];
}
export interface RemoteAccessInstallJob {
  provider: RemoteAccessProviderId;
  status: "running" | "succeeded" | "failed";
  stage: "preparing" | "refreshing" | "installing" | "checking" | "done";
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}
export interface RemoteAccessOverview {
  providers: Array<{
    node: RemoteAccessNode;
    settings: RemoteAccessSettings;
    configured: boolean;
    installation: RemoteAccessInstallJob | null;
  }>;
  conflicts: RemoteAccessConflict[];
  canManage: boolean;
}
