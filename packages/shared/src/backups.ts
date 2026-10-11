import type { LocalizedText } from "./catalogs.ts";

/*
 * Backup and restore (docs/backups.md). A backup is a directory of checksummed
 * files described by manifest.json; it is downloaded as one tar archive.
 */

/** `YYYYMMDD-HHMMSS-xxxxxx` (UTC time plus a random suffix). */
export const BACKUP_ID_PATTERN = /^\d{8}-\d{6}-[a-f0-9]{6}$/;

export const BACKUP_FORMAT = "otuken-backup";
export const BACKUP_FORMAT_VERSION = 1;

export type BackupTrigger = "manual" | "schedule" | "pre-restore";

/** How an installed app's data can be backed up. */
export type AppDataSupport =
  /** Everything the app stores lives in its Otuken app data directory. */
  | "supported"
  /** Some data is in Docker volumes or host paths Otuken cannot capture consistently. */
  | "unsupported"
  /** The app declares no persistent storage. */
  | "none";

export interface BackupAppContent {
  id: string;
  name: LocalizedText;
  /** The app's data directory is included (captured while the app was stopped). */
  data: boolean;
  /** Uncompressed size of the data and number of entries. */
  dataBytes: number;
  dataEntries: number;
  /** Sockets, pipes and device files that were left out. */
  skipped: number;
}

export interface BackupManifestFile {
  name: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_FORMAT_VERSION;
  id: string;
  createdAt: number;
  trigger: BackupTrigger;
  createdBy: string | null;
  note: string | null;
  otukenVersion: string;
  /** Database schema version of the snapshot. */
  schemaVersion: number;
  hostname: string;
  /** Fingerprint of the server secret that encrypts stored secrets (not the secret itself). */
  keyId: string;
  contents: {
    database: true;
    config: boolean;
    wallpapers: boolean;
    apps: BackupAppContent[];
  };
  files: BackupManifestFile[];
}

export interface BackupVerification {
  at: number;
  ok: boolean;
  /** Machine-readable reason when not ok (e.g. "checksum:otuken.db.gz"). */
  error: string | null;
}

export interface BackupView {
  id: string;
  createdAt: number;
  trigger: BackupTrigger;
  createdBy: string | null;
  note: string | null;
  otukenVersion: string;
  schemaVersion: number;
  hostname: string;
  /** Total size of the stored files. */
  size: number;
  contents: BackupManifest["contents"];
  /** Pinned backups are never removed by retention. */
  pinned: boolean;
  /** Imported from an uploaded archive. */
  uploaded: boolean;
  /** Made with this server's secret (encrypted settings can be read after a restore). */
  sameKey: boolean;
  verification: BackupVerification | null;
}

export type BackupJobKind = "backup" | "restore";

export type BackupJobStage =
  | "preparing"
  | "database"
  | "files"
  | "app-stop"
  | "app-data"
  | "app-start"
  | "verify"
  | "safety"
  | "restore-data"
  | "restore-settings"
  | "stage-database"
  | "done";

export type BackupJobStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface BackupJobView {
  id: string;
  kind: BackupJobKind;
  trigger: BackupTrigger;
  status: BackupJobStatus;
  stage: BackupJobStage;
  /** App currently being processed. */
  appId: string | null;
  /** Bytes written so far (backups) or transferred (restores). */
  bytes: number;
  startedAt: number;
  finishedAt: number | null;
  username: string | null;
  /** The backup created, or the one being restored. */
  backupId: string | null;
  error: string | null;
  /** After a database restore: "automatic" (Otuken restarts itself) or "manual". */
  restart: "automatic" | "manual" | null;
}

export interface BackupSettings {
  /** Unpinned backups kept by retention (oldest removed first). */
  keep: number;
  /** Apps whose data scheduled backups include (they are stopped briefly). */
  appData: string[];
}

export interface BackupAppOption {
  id: string;
  name: LocalizedText;
  state: string;
  data: AppDataSupport;
}

export interface BackupOverview {
  backups: BackupView[];
  job: BackupJobView | null;
  /** Most recent finished job (for showing its result). */
  lastJob: BackupJobView | null;
  settings: BackupSettings;
  apps: BackupAppOption[];
  storage: {
    /** Display path of the backup directory. */
    location: string;
    freeBytes: number | null;
    usedBytes: number;
    /** Space always left free on that filesystem. */
    reserveBytes: number;
  };
  /** Whether a database restore can restart Otuken automatically. */
  supervised: boolean;
}

export type RestoreScope = "desktop" | "database";

export interface RestorePreview {
  backup: BackupView;
  verification: BackupVerification;
  /** Why a database restore is impossible (e.g. "newer-schema", "different-key"). */
  databaseBlocked: string | null;
  database: {
    schemaVersion: number;
    currentSchemaVersion: number;
    users: { username: string; role: string; status: "same" | "added" | "removed" }[];
    apps: { id: string; name: LocalizedText; status: "same" | "added" | "removed" }[];
    tasks: number;
    catalogs: number;
  };
  /** Users whose desktop (layout, widgets, preferences, wallpapers) can be restored. */
  desktopUsers: string[];
  config: "same" | "different" | "absent";
  apps: Array<{
    id: string;
    name: LocalizedText;
    /** "ok", or why the data cannot be restored ("not-installed", "unsupported"). */
    restorable: "ok" | "not-installed" | "unsupported";
    dataBytes: number;
  }>;
}
