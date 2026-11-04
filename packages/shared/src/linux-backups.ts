export type LinuxBackupScope = "system" | "full" | "custom";
export type LinuxBackupEncryption = "none" | "repokey-blake2";

export interface LinuxBackupSchedule {
  frequency: "manual" | "hourly" | "daily" | "weekly" | "monthly";
  hour: number;
  minute: number;
  weekday: number;
  /** Restricted to 1–28 so every month has the selected day. */
  day: number;
}

export interface LinuxBackupRetention {
  enabled: boolean;
  hourly: number;
  daily: number;
  weekly: number;
  monthly: number;
}

export interface LinuxBackupSelection {
  scope: LinuxBackupScope;
  includes: string[];
  excludes: string[];
  excludeCaches: boolean;
}

export interface LinuxBackupPlan extends LinuxBackupSelection {
  id: string;
  name: string;
  targetId: string;
  targetPath: string;
  targetDevice: string;
  encryption: LinuxBackupEncryption;
  compression: "lz4" | "zstd,3" | "none";
  retention: LinuxBackupRetention;
  schedule: LinuxBackupSchedule;
  taskId: string | null;
  createdAt: number;
  nextRunAt: number | null;
  /** A custom schedule edited in Tasks; saving a preset replaces it. */
  scheduleOverride: string | null;
}

export interface LinuxBackupCapability {
  source: "host" | "simulated";
  available: boolean;
  reason:
    | "ready"
    | "linux-required"
    | "root-required"
    | "borg-missing"
    | "borg-version"
    | "development-mode";
  version: string | null;
  installationSupported: boolean;
  targets: Array<{
    id: string;
    path: string;
    device: string;
    freeBytes: number | null;
    available: boolean;
  }>;
  systemIncludes: string[];
  alwaysExcluded: string[];
}

export interface LinuxBackupArchive {
  name: string;
  id: string;
  createdAt: number;
  verification: "verified" | "warning" | "unknown";
  scope: LinuxBackupScope | null;
}

export interface LinuxBackupJob {
  id: string;
  planId: string;
  kind: "create" | "verify" | "restore" | "prune";
  status: "running" | "succeeded" | "warning" | "failed" | "cancelled";
  stage: "preparing" | "archiving" | "verifying" | "restoring" | "retention" | "done";
  archive: string | null;
  startedAt: number;
  finishedAt: number | null;
  files: number;
  bytes: number;
  compressedBytes: number;
  deduplicatedBytes: number;
  error: string | null;
  /** A fresh directory, never the running system's root. */
  restorePath: string | null;
}

export interface LinuxBackupOverview {
  capability: LinuxBackupCapability;
  plans: LinuxBackupPlan[];
  job: LinuxBackupJob | null;
  history: LinuxBackupJob[];
  timezone: string;
  installation: LinuxBackupInstallation | null;
}

export function linuxBackupCron(schedule: LinuxBackupSchedule): string | null {
  const { frequency, hour, minute, weekday, day } = schedule;
  switch (frequency) {
    case "manual":
      return null;
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`;
    case "monthly":
      return `${minute} ${hour} ${day} * *`;
  }
}

export interface LinuxBackupInstallation {
  id: string;
  status: "running" | "succeeded" | "failed";
  stage: "preparing" | "refreshing" | "installing" | "checking" | "done";
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}
