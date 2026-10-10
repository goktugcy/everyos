import type { IntegrationAdapter } from "./widgets.ts";

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
export interface InstallField {
  label: LocalizedText;
  hint: LocalizedText;
  type:
    | "text"
    | "password"
    | "random"
    | "boolean"
    | "number"
    | "email"
    | "url"
    | "ip"
    | "fqdn"
    | "fqdnip";
  min: number | null;
  max: number | null;
  pattern: string | null;
  options: { label: string; value: string }[];
  encoding: "hex" | "base64" | null;
}
export interface AppImage {
  reference: string;
  digest: string | null;
  platform: string;
}

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
  variants: Record<string, string>;
  contentHash: string | null;
  cacheKey?: string;
  screenshots: string[];
  links: { documentation: string | null; website: string | null; repository: string | null };
  notes: LocalizedText;
  web: { path: string; scheme: "http" | "https"; service?: string; port?: number };
  risks: InstallRisk[];
  /** Unsupported host-side features are never eligible for an override. */
  blockers: string[];
  variables: {
    key: string;
    required: boolean;
    secret: boolean;
    default: string | null;
    generated: boolean;
    field?: InstallField;
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
export type CatalogAppView = Omit<CatalogApp, "compose" | "variants"> & {
  duplicates: string[];
  /** Built-in widget adapters matching the app's images (never taken from catalog claims). */
  widgetAdapters: IntegrationAdapter[];
};
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

export const APP_ACTIONS = [
  "install",
  "retry",
  "start",
  "stop",
  "restart",
  "update",
  "remove",
] as const;
export type AppAction = (typeof APP_ACTIONS)[number];
export interface InstalledAppView {
  id: string;
  name: LocalizedText;
  project: string;
  provenance: CatalogApp["source"];
  source: "host" | "simulated";
  state: "running" | "degraded" | "stopped" | "missing" | "busy";
  lastError: string | null;
  installedAt: number;
  images: AppImage[];
  web: CatalogApp["web"];
  ports: { port: number; hostIp: string | null }[];
  lastJob: AppJobView | null;
  dataCopyEligible: boolean;
  /** Built-in widget adapters matching the deployed images. */
  widgetAdapters: IntegrationAdapter[];
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
