/*
 * Desktop apps (docs/app-sdk/architecture.md): what the store, the desktop and the management
 * screens see. Manifests and registry indexes themselves are validated on the server only.
 */

export const DESKTOP_APP_REGISTRY_KINDS = ["official", "community", "private"] as const;
export type DesktopAppRegistryKind = (typeof DESKTOP_APP_REGISTRY_KINDS)[number];

export const DESKTOP_APP_STATES = ["active", "disabled", "revoked"] as const;
export type DesktopAppState = (typeof DESKTOP_APP_STATES)[number];

export type DesktopAppCapabilityRisk = "standard" | "sensitive" | "elevated";

/** Most registries an administrator can add. */
export const MAX_DESKTOP_APP_REGISTRIES = 16;

export interface DesktopAppRegistryView {
  id: string;
  kind: DesktopAppRegistryKind;
  name: string;
  url: string;
  /** `sha256:<hex>` of the registry key, to compare with what the publisher shows. */
  fingerprint: string;
  enabled: boolean;
  allowPrivate: boolean;
  hasToken: boolean;
  syncedAt: number | null;
  sequence: number | null;
  expiresAt: number | null;
  appCount: number;
  lastError: string | null;
}

export interface DesktopAppPermissionView {
  capability: string;
  risk: DesktopAppCapabilityRisk;
}

export interface DesktopAppWindowView {
  defaultWidth: number;
  defaultHeight: number;
  minWidth: number;
  minHeight: number;
  instances: "single" | "multiple";
}

export interface DesktopAppWidgetView {
  id: string;
  name: string;
  description: string;
  entry: string;
  sizes: Array<"compact" | "small" | "medium" | "large">;
  defaultSize: "compact" | "small" | "medium" | "large";
  placements: Array<"desktop" | "sidebar" | "menubar">;
  permissions: string[];
}

export type DesktopAppIncompatibility = "everyos-too-old" | "sdk-unsupported";

/** One app as one registry offers it (the store). */
export interface DesktopAppListing {
  appId: string;
  registry: { id: string; name: string; kind: DesktopAppRegistryKind };
  publisher: { id: string; name: string; url: string | null };
  name: string;
  description: string;
  category: string;
  version: string;
  license: string | null;
  homepage: string | null;
  source: string | null;
  permissions: DesktopAppPermissionView[];
  widgets: number;
  locales: string[];
  versions: Array<{ version: string; publishedAt: number; changelog: string | null }>;
  screenshots: number;
  incompatible: DesktopAppIncompatibility | null;
  /** Why the registry revoked this version, when it did. */
  revoked: string | null;
  /** Another enabled registry offers the same app id from a different publisher key. */
  conflict: boolean;
  installed: { version: string; state: DesktopAppState; registryId: string | null } | null;
  /** A newer compatible version than the installed one, from the registry it came from. */
  updateAvailable: string | null;
}

/** An installed app, as the desktop runs it. */
export interface DesktopAppInstallationView {
  appId: string;
  version: string;
  name: string;
  description: string;
  category: string;
  registry: { id: string; name: string; kind: DesktopAppRegistryKind } | null;
  publisher: { id: string; name: string };
  /** Base of the app's files: `/app-runtime/<key>/`. */
  runtimeUrl: string;
  entry: string;
  icon: string;
  window: DesktopAppWindowView;
  widgets: DesktopAppWidgetView[];
  locales: { default: string; supported: string[]; path: string } | null;
  permissions: Array<DesktopAppPermissionView & { granted: boolean }>;
  state: DesktopAppState;
  stateReason: string | null;
  installedAt: number;
  updatedAt: number;
}

/** Capabilities an install or update needs someone to approve. */
export interface DesktopAppApprovalRequired {
  sensitive: string[];
  elevated: string[];
}
