/*
 * Google Drive for each person (docs/drive.md): an administrator registers the owner's own OAuth
 * client once; every person connects their own Drive with full access.
 */

/** My Drive's root, and the virtual folder of files shared with the person. */
export const DRIVE_ROOT = "root";
export const DRIVE_SHARED = "shared";
export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
/** Full Drive access: browse, upload, download, rename and trash the person's files. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/** Google Docs editors files have no bytes of their own; they are exported in Office formats. */
export const DRIVE_EXPORTS: Readonly<Record<string, { mime: string; extension: string }>> = {
  "application/vnd.google-apps.document": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  },
  "application/vnd.google-apps.presentation": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extension: "pptx",
  },
  "application/vnd.google-apps.drawing": { mime: "image/png", extension: "png" },
};

export interface DriveClientView {
  configured: boolean;
  clientId: string | null;
}

export interface DriveAccount {
  email: string;
  name: string | null;
  /** `reconnect`: Google no longer accepts the stored authorization. */
  status: "connected" | "reconnect";
  quota: { usedBytes: number | null; limitBytes: number | null } | null;
  connectedAt: number;
}

export interface DriveAccountView {
  /** An administrator registered a Google client. */
  configured: boolean;
  account: DriveAccount | null;
}

export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  folder: boolean;
  /** Null for folders and Google Docs files. */
  sizeBytes: number | null;
  modifiedAt: number | null;
  /** A Google Docs editors file, exported with this extension when copied out. */
  exportAs: string | null;
  /** Other Google-only files (forms, sites…) cannot be downloaded. */
  downloadable: boolean;
  canEdit: boolean;
}

export interface DriveListing {
  folder: { id: string; name: string };
  /** From My Drive (or Shared with me) down to the folder. */
  path: Array<{ id: string; name: string }>;
  entries: DriveEntry[];
  nextPageToken: string | null;
}
