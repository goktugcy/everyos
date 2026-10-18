import type { LocalizedText } from "./catalogs.ts";

/*
 * Backup and restore (docs/backups.md). A backup is a directory of checksummed
 * files described by manifest.json; it is downloaded as one tar archive.
 */

/** `YYYYMMDD-HHMMSS-xxxxxx` (UTC time plus a random suffix). */
export const BACKUP_ID_PATTERN = /^\d{8}-\d{6}-[a-f0-9]{6}$/;

export const BACKUP_FORMAT = "everyos-backup";
export const BACKUP_FORMAT_VERSION = 1;

export type BackupTrigger = "manual" | "schedule" | "pre-restore";

/** How an installed app's data can be backed up. */
export type AppDataSupport =
  /** Everything the app stores lives in its EveryOS app data directory. */
  | "supported"
  /** Some data is in Docker volumes or host paths EveryOS cannot capture consistently. */
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

export interface BackupHomeContent {
  userId: string;
  username: string;
  dataBytes: number;
  dataEntries: number;
  skipped: number;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_FORMAT_VERSION;
  id: string;
  createdAt: number;
  trigger: BackupTrigger;
  createdBy: string | null;
  note: string | null;
  everyosVersion: string;
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
    /** EveryOS-managed homes, including Desktop files and their private trash. Absent in older backups. */
    homes?: BackupHomeContent[];
  };
  files: BackupManifestFile[];
}

export interface BackupVerification {
  at: number;
  ok: boolean;
  /** Machine-readable reason when not ok (e.g. "checksum:everyos.db.gz"). */
  error: string | null;
}

export interface BackupView {
  id: string;
  createdAt: number;
  trigger: BackupTrigger;
  createdBy: string | null;
  note: string | null;
  everyosVersion: string;
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
  /**
   * The server secret it was made with is known here (the current one, one replaced by a restore
   * or one that came inside an encrypted backup), so the whole database can be restored.
   */
  keyAvailable: boolean;
  verification: BackupVerification | null;
  /** The last off-site copy of this backup. */
  offsite: BackupOffsiteState | null;
}

export interface BackupOffsiteState {
  at: number;
  ok: boolean;
  /** Where it went, for display ("S3: bucket/prefix", a disk label, "Google Drive"). */
  target: string;
  /** File name at the destination. */
  name: string | null;
  error: string | null;
}

export type BackupJobKind = "backup" | "restore" | "offsite";

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
  | "offsite"
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
  /** After a database restore: "automatic" (EveryOS restarts itself) or "manual". */
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
  /** Whether a database restore can restart EveryOS automatically. */
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
  homes: Array<BackupHomeContent & { restorable: "ok" | "not-found" | "disabled" }>;
  config: "same" | "different" | "absent";
  apps: Array<{
    id: string;
    name: LocalizedText;
    /** "ok", or why the data cannot be restored ("not-installed", "unsupported"). */
    restorable: "ok" | "not-installed" | "unsupported";
    dataBytes: number;
  }>;
}

/* ------------------------------------------------- encryption and off-site */

/** File extension of passphrase-encrypted backups. */
export const ENCRYPTED_BACKUP_EXTENSION = ".eosbak";

export interface BackupEncryptionView {
  /** A passphrase is set: downloads can be encrypted and off-site copies are possible. */
  configured: boolean;
  setAt: number | null;
  setBy: string | null;
}

export const OFFSITE_KINDS = ["disk", "s3", "drive"] as const;
export type OffsiteKind = (typeof OFFSITE_KINDS)[number];

export type OffsiteTargetView =
  | {
      kind: "disk";
      uuid: string;
      /** Null while the disk is not mounted. */
      label: string | null;
      folder: string;
      /** The administrator whose Linux account writes there. */
      username: string | null;
    }
  | {
      kind: "s3";
      endpoint: string;
      region: string;
      bucket: string;
      prefix: string;
      pathStyle: boolean;
      accessKeyId: string;
    }
  | {
      kind: "drive";
      /** Whose Google Drive receives the copies. */
      username: string | null;
      folder: string;
      connected: boolean;
    };

export interface OffsiteView {
  target: OffsiteTargetView | null;
  /** Copies kept at the destination (older EveryOS copies there are removed). */
  keep: number;
  /** Copy every manual and scheduled backup right after it is made. */
  auto: boolean;
  encryption: BackupEncryptionView;
}

/** Header details of an uploaded encrypted backup, before its passphrase is given. */
export interface EncryptedUpload {
  encrypted: true;
  uploadId: string;
  backupId: string;
  createdAt: number;
  hostname: string;
  everyosVersion: string;
  includesKey: boolean;
}
