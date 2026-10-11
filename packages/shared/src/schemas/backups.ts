import { z } from "zod";
import { PASSWORD_MAX_LENGTH } from "../api-types.ts";
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, BACKUP_ID_PATTERN } from "../backups.ts";

export const BackupIdSchema = z.string().regex(BACKUP_ID_PATTERN);

const LocalizedTextSchema = z.record(z.string().max(16), z.string().max(200));
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const AppIdsSchema = z
  .array(z.string().uuid())
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, "duplicate app");

/** Names a backup may contain (anything else in an archive is rejected). */
export const BACKUP_FILE_NAME =
  /^(?:manifest\.json|otuken\.db\.gz|config\.yaml|wallpapers\.tar\.gz|homes\.tar\.gz|apps\/[0-9a-f-]{36}\.data\.tar\.gz)$/;

export const BackupManifestSchema = z
  .strictObject({
    format: z.literal(BACKUP_FORMAT),
    version: z.literal(BACKUP_FORMAT_VERSION),
    id: BackupIdSchema,
    createdAt: z.number().int().nonnegative(),
    trigger: z.enum(["manual", "schedule", "pre-restore"]),
    createdBy: z.string().max(64).nullable(),
    note: z.string().max(200).nullable(),
    otukenVersion: z.string().max(32),
    schemaVersion: z.number().int().positive(),
    hostname: z.string().max(255),
    keyId: z.string().regex(/^[a-f0-9]{32}$/),
    contents: z.strictObject({
      database: z.literal(true),
      config: z.boolean(),
      wallpapers: z.boolean(),
      homes: z
        .array(
          z.strictObject({
            userId: z.string().uuid(),
            username: z.string().max(64),
            dataBytes: z.number().int().nonnegative(),
            dataEntries: z.number().int().nonnegative(),
            skipped: z.number().int().nonnegative(),
          }),
        )
        .max(1000)
        .default([])
        .refine(
          (homes) => new Set(homes.map((home) => home.userId)).size === homes.length,
          "duplicate home",
        ),
      apps: z
        .array(
          z.strictObject({
            id: z.string().uuid(),
            name: LocalizedTextSchema,
            data: z.boolean(),
            dataBytes: z.number().int().nonnegative(),
            dataEntries: z.number().int().nonnegative(),
            skipped: z.number().int().nonnegative(),
          }),
        )
        .max(100),
    }),
    files: z
      .array(
        z.strictObject({
          name: z
            .string()
            .regex(BACKUP_FILE_NAME)
            .refine((name) => name !== "manifest.json"),
          size: z.number().int().nonnegative(),
          sha256: Sha256Schema,
        }),
      )
      .min(1)
      .max(111),
  })
  .refine(
    (manifest) =>
      manifest.contents.homes.length > 0 ===
      manifest.files.some((file) => file.name === "homes.tar.gz"),
    "home archive mismatch",
  );

export const BackupCreateRequestSchema = z.strictObject({
  /** Apps whose data to include (each is stopped while its data is copied). */
  apps: AppIdsSchema.default([]),
  note: z.string().trim().max(200).optional(),
});

export const BackupSettingsSchema = z.strictObject({
  keep: z.number().int().min(1).max(100),
  appData: AppIdsSchema,
});

export const BackupPinRequestSchema = z.strictObject({ pinned: z.boolean() });

export const BackupDownloadRequestSchema = z.strictObject({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const BackupDownloadQuerySchema = z.strictObject({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/),
});

export const RestoreRequestSchema = z
  .strictObject({
    /** Otuken's own data: nothing, every user's desktop, or the whole database. */
    settings: z.enum(["none", "desktop", "database"]),
    /** Apps whose data to restore (each is stopped while its data is replaced). */
    apps: AppIdsSchema,
    /** Restore homes of accounts that still exist, with a safety backup first. */
    homes: z.boolean().default(false),
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    confirm: z.literal(true),
  })
  .refine(
    (value) => value.settings !== "none" || value.apps.length > 0 || value.homes,
    "nothing-selected",
  );

/* Agent operations: app data archives travel through the agent in chunks. */

/** Raw bytes per chunk (base64 adds a third; the agent accepts 1 MiB messages). */
export const APP_DATA_CHUNK_BYTES = 512 * 1024;
const Base64ChunkSchema = z
  .string()
  .max(Math.ceil(APP_DATA_CHUNK_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

const TransferTokenSchema = z.string().regex(/^[a-f0-9]{32}$/);

/*
 * Exports are pulled chunk by chunk, so the API sets the pace: the agent only
 * produces the next part of the archive when it is asked for it.
 */
export const AppDataExportBeginSchema = z.strictObject({ id: z.string().uuid() });
export const AppDataExportBeginResultSchema = z.strictObject({
  token: TransferTokenSchema,
  /** Uncompressed size and number of entries that will be archived. */
  entries: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export const AppDataExportReadSchema = z.strictObject({ token: TransferTokenSchema });
export const AppDataExportReadResultSchema = z.discriminatedUnion("done", [
  z.strictObject({ done: z.literal(false), data: Base64ChunkSchema }),
  z.strictObject({
    done: z.literal(true),
    size: z.number().int().nonnegative(),
    sha256: Sha256Schema,
  }),
]);
export const AppDataTransferAbortSchema = z.strictObject({ token: TransferTokenSchema });

const ImportTokenSchema = TransferTokenSchema;

export const AppDataImportBeginSchema = z.strictObject({
  id: z.string().uuid(),
  /** Size of the compressed archive that will be sent. */
  size: z
    .number()
    .int()
    .nonnegative()
    .max(1024 ** 4),
});
export const AppDataImportChunkSchema = z.strictObject({
  token: ImportTokenSchema,
  offset: z.number().int().nonnegative(),
  data: Base64ChunkSchema,
});
export const AppDataImportCommitSchema = z.strictObject({
  token: ImportTokenSchema,
  sha256: Sha256Schema,
});
export const AppDataImportResultSchema = z.strictObject({
  entries: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
