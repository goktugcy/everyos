/*
 * Zod-free entry point, safe for browser bundles. Validation schemas live in
 * "@everyos/shared/schemas"; only their inferred *types* are re-exported here
 * (type-only exports are erased at runtime).
 */
export * from "./api-types.ts";
export * from "./catalogs.ts";
export * from "./docker.ts";
export * from "./errors.ts";
export * from "./environment.ts";
export * from "./files.ts";
export * from "./host.ts";
export * from "./home-assistant.ts";
export * from "./home-assistant-controls.ts";
export * from "./locale.ts";
export * from "./notifications.ts";
export * from "./permissions.ts";
export * from "./preferences.ts";
export * from "./system.ts";
export * from "./self-update.ts";
export * from "./terminal.ts";
export * from "./updates.ts";
export * from "./cron.ts";
export * from "./tasks.ts";
export * from "./backups.ts";
export * from "./tailscale.ts";
export * from "./widgets.ts";
export type { CapabilityStatus, SystemInfo } from "./schemas/system.ts";
export type {
  ComposeActionResult,
  ComposeFileCheck,
  ComposeProject,
  ComposeProjectList,
  ComposeProjectView,
  ContainerDetail,
  ContainerList,
  ContainerLogLine,
  ContainerStatsList,
  ContainerStatsSample,
  ContainerSummary,
  DockerContainerView,
  DockerEvent,
  DockerStatus,
  ImageList,
  ImageSummary,
  NetworkList,
  NetworkSummary,
  VolumeList,
  VolumeSummary,
} from "./schemas/docker.ts";
export type { PostgresStats } from "./schemas/widgets.ts";
export type { NotificationPreferences } from "./schemas/notifications.ts";
export type { PulsePreferences, ShelfItem } from "./schemas/pulse.ts";
export type {
  CpuTimes,
  HardwareStatus,
  LogEntry,
  LogPage,
  LogQuery,
  MetricsSample,
  NetworkStatus,
  ProcessList,
  ServiceDetail,
  ServiceList,
  ServiceUnit,
  StorageUsage,
  TailscaleDetails,
  TailscalePeer,
  TailscalePeers,
  TailscaleStatus,
} from "./schemas/host.ts";
export type {
  AppearancePreferences,
  CustomTheme,
  DesktopFilePosition,
  DesktopItem,
  DesktopPreferences,
  DockPreferences,
  FolderIconSpec,
  MenubarPreferences,
  PersistedWindow,
  PreferenceDocuments,
  SecurityPreferences,
  ThemeEffects,
  VirtualDesktop,
  WallpaperSpec,
  WindowSession,
} from "./schemas/preferences.ts";
export type {
  CreateUserRequest,
  LoginRequest,
  LoginTotpRequest,
  SetupRequest,
  UpdateUserRequest,
} from "./schemas/api.ts";

/** Single coordinated product version (see docs/decisions.md). */
export const EVERYOS_VERSION = "0.1.23";

/** HTTP header carrying the per-session CSRF token on state-changing requests. */
export const CSRF_HEADER = "x-everyos-csrf";

export * from "./power.ts";

export * from "./linux-accounts.ts";
export * from "./ai-agents.ts";
