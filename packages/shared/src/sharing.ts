import type { RemoteAccessNode } from "./remote-access.ts";

/** Built-in network storage. Public connection DTOs omit credentials. */
export const SHARING_PROTOCOLS = ["nfs", "smb", "sftp"] as const;
export type SharingProtocol = (typeof SHARING_PROTOCOLS)[number];
export type SharingState =
  "connected" | "disconnected" | "unavailable" | "disabled" | "error" | "unknown";
// Keep all 128 UUID bits within the existing 32-character lowercase Files root namespace.
export const networkRootId = (id: string) =>
  "net-" +
  BigInt("0x" + id.replaceAll("-", ""))
    .toString(36)
    .padStart(25, "0");
export const isNetworkRoot = (root: string) => /^net-[a-z0-9]{25}$/.test(root);
export interface NetworkConnection {
  id: string;
  name: string;
  protocol: SharingProtocol;
  host: string;
  port: number;
  remotePath: string;
  username: string;
  readOnly: boolean;
  enabled: boolean;
  persistent: boolean;
  automount: boolean;
  version: string;
  fingerprint: string | null;
  root: string;
  mountPoint: string | null;
  mountName?: string;
  state: SharingState;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface NetworkFolderShare {
  id: string;
  name: string;
  protocol: "nfs" | "smb";
  root: string;
  path: string;
  readOnly: boolean;
  enabled: boolean;
  clients: string[];
  users: string[];
  state: SharingState;
  reason: string | null;
  createdAt: number;
}
export interface SharingServiceStatus {
  protocol: SharingProtocol | "discovery" | "nfs-client" | "smb-client";
  installed: boolean;
  active: boolean;
  installSupported: boolean;
}
export interface NetworkMountView {
  id: string | null;
  owner: string | null;
  protocol: "nfs" | "smb";
  source: string;
  target: string;
  readOnly: boolean;
  mounted: boolean;
  managed: boolean;
  reachable: boolean | null;
}
export interface SharingHostStatus {
  exports: Array<{ id: string; active: boolean }>;
  externalExports: Array<{ path: string; client: string }>;
  sshPorts: number[];
  source: "host" | "simulated";
  supported: boolean;
  services: SharingServiceStatus[];
  mounts: NetworkMountView[];
  addresses: string[];
  reason: string | null;
  installation: {
    state: "running" | "succeeded" | "failed";
    protocol: string;
    reason: string | null;
  } | null;
}
export interface QuickShareView {
  id: string;
  name: string;
  direction: "send" | "receive";
  root: string;
  paths: string[];
  expiresAt: number;
  oneTime: boolean;
  passwordProtected: boolean;
  claimed: boolean;
  exhausted: boolean;
  maxDownloads: number;
  downloads: number;
  maxBytes: number;
  bytesReceived: number;
  revoked: boolean;
  createdAt: number;
}
export interface SharingOverview {
  host: SharingHostStatus;
  privateNetworks: RemoteAccessNode[];
  connections: NetworkConnection[];
  shares: NetworkFolderShare[];
  quickShares: QuickShareView[];
}
