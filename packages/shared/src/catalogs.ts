export const CATALOG_FORMATS = [
  "auto",
  "casaos-v2",
  "casaos-source",
  "runtipi",
  "coolify",
  "portainer",
  "compose-dir",
] as const;
export const INSTALL_RISKS = [
  "privileged",
  "host-network",
  "host-pid",
  "docker-socket",
  "sensitive-host-path",
  "devices",
  "cap-add",
  "security-opt-unconfined",
  "unpinned-image",
  "default-secret",
] as const;
export type InstallRisk = (typeof INSTALL_RISKS)[number];
export type CatalogFormat = (typeof CATALOG_FORMATS)[number];
export type LocalizedText = Record<string, string>;

export interface CatalogApp {
  id: string;
  nativeId: string;
  logicalKey: string;
  name: LocalizedText;
  description: LocalizedText;
  categories: string[];
  icon: string | null;
  version: string | null;
  architectures: string[];
  source: { catalogId: string; format: CatalogFormat; ref: string; path: string };
  images: string[];
  risks: InstallRisk[];
  /** Unsupported host-side features are never eligible for an override. */
  blockers: string[];
  variables: {
    key: string;
    required: boolean;
    secret: boolean;
    default: string | null;
    generated: boolean;
  }[];
  ports: {
    service: string;
    index: number;
    container: number;
    host: number | null;
    protocol: "tcp" | "udp";
  }[];
  mounts: {
    service: string;
    source: string | null;
    target: string;
    kind: "bind" | "volume";
    readOnly: boolean;
  }[];
  compose: string;
}
export type CatalogAppView = Omit<CatalogApp, "compose"> & { duplicates: string[] };
export interface CatalogView {
  id: string;
  name: string;
  url: string;
  format: CatalogFormat;
  enabled: boolean;
  allowPrivate: boolean;
  syncedAt: number | null;
  snapshot: string | null;
  appCount: number;
  skipped: { path: string; reason: string }[];
  lastError: string | null;
}

export const APP_ACTIONS = ["install", "start", "stop", "restart", "update", "remove"] as const;
export type AppAction = (typeof APP_ACTIONS)[number];
export interface InstalledAppView {
  id: string;
  name: LocalizedText;
  project: string;
  provenance: CatalogApp["source"];
  source: "host" | "simulated";
  state: "running" | "stopped" | "missing" | "busy";
  lastError: string | null;
  installedAt: number;
}
export interface AppJobView {
  id: string;
  appId: string;
  action: AppAction;
  stage: "queued" | "deploying" | "succeeded" | "failed";
  error: string | null;
  rollback: "not-needed" | "succeeded" | "failed" | "unknown";
  createdAt: number;
  updatedAt: number;
}
