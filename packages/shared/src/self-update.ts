export const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const RELEASE_JOB_STATES = [
  "queued",
  "downloading",
  "verifying",
  "installing",
  "restarting",
  "succeeded",
  "rolling-back",
  "rolled-back",
  "failed",
] as const;
export type ReleaseJobState = (typeof RELEASE_JOB_STATES)[number];
export interface ReleaseJob {
  id: string;
  version: string;
  previousVersion: string;
  backupId: string;
  state: ReleaseJobState;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
}
export interface AvailableRelease {
  version: string;
  minVersion: string;
  schemaVersion: number;
  notes: string;
  publishedAt: number;
}
export interface SelfUpdateStatus {
  source: "host";
  installedVersion: string;
  architecture: "arm64" | "amd64" | null;
  configured: boolean;
  reason: "development-mode" | "not-linux" | "not-configured" | null;
  checkedAt: number | null;
  available: AvailableRelease | null;
  job: ReleaseJob | null;
}
