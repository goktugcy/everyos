import { z } from "zod";
import { PASSWORD_MAX_LENGTH } from "../api-types.ts";

const utf8Length = (value: string) =>
  Array.from(value).reduce((length, character) => {
    const code = character.codePointAt(0)!;
    return length + (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4);
  }, 0);

export const LinuxBackupPathSchema = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      value.startsWith("/") &&
      Array.from(value).every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) &&
      (value === "/" ||
        value
          .split("/")
          .slice(1)
          .every((part) => part !== "" && part !== "." && part !== "..")),
    "absolute-path-required",
  );
const uuid = z.string().uuid();
export const LinuxBackupArchiveNameSchema = z
  .string()
  .regex(/^eos-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/);
export const LinuxBackupSelectionSchema = z.strictObject({
  scope: z.enum(["system", "full", "custom"]),
  includes: z
    .array(LinuxBackupPathSchema)
    .max(64)
    .refine((paths) => paths.reduce((n, p) => n + utf8Length(p), 0) <= 16_384, "paths-too-large")
    .refine(
      (paths) =>
        !paths.some((path, i) =>
          paths.some(
            (parent, j) =>
              i !== j && (path === parent || path.startsWith(parent === "/" ? "/" : parent + "/")),
          ),
        ),
      "overlapping-sources",
    ),
  excludes: z
    .array(LinuxBackupPathSchema.refine((p) => p !== "/", "cannot-exclude-root"))
    .max(128)
    .refine((paths) => paths.reduce((n, p) => n + utf8Length(p), 0) <= 16_384, "paths-too-large"),
  excludeCaches: z.boolean(),
});
export const LinuxBackupScheduleSchema = z.strictObject({
  frequency: z.enum(["manual", "hourly", "daily", "weekly", "monthly"]),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  weekday: z.number().int().min(0).max(6),
  day: z.number().int().min(1).max(28),
});
export const LinuxBackupRetentionSchema = z
  .strictObject({
    enabled: z.boolean(),
    hourly: z.number().int().min(0).max(744),
    daily: z.number().int().min(0).max(366),
    weekly: z.number().int().min(0).max(104),
    monthly: z.number().int().min(0).max(120),
  })
  .refine((v) => !v.enabled || v.hourly + v.daily + v.weekly + v.monthly > 0, "retention-required");
const plan = LinuxBackupSelectionSchema.extend({
  name: z.string().trim().min(1).max(80),
  targetId: z.string().regex(/^[a-f0-9]{16}$/),
  encryption: z.enum(["none", "repokey-blake2"]),
  compression: z.enum(["lz4", "zstd,3", "none"]),
  schedule: LinuxBackupScheduleSchema,
  retention: LinuxBackupRetentionSchema,
});
export const LinuxBackupPlanRequestSchema = plan
  .extend({
    unencryptedConsent: z.boolean().default(false),
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    passphrase: z
      .string()
      .min(12)
      .max(1024)
      .regex(/^[^\r\n\0]+$/)
      .optional(),
  })
  .refine((v) => v.scope !== "custom" || v.includes.length > 0, "sources-required")
  .refine((v) => v.encryption !== "none" || v.unencryptedConsent, "unencrypted-consent-required");
export const LinuxBackupSpecSchema = plan.omit({ name: true, schedule: true }).extend({
  planId: uuid,
  targetDevice: z.string().regex(/^(?:\d+|uuid:[a-z0-9-]{1,128})$/i),
  passphrase: z
    .string()
    .max(1024)
    .regex(/^[^\r\n\0]*$/),
});
export const LinuxBackupStartSchema = z
  .strictObject({
    spec: LinuxBackupSpecSchema,
    kind: z.enum(["create", "verify", "restore", "prune", "delete"]),
    archive: LinuxBackupArchiveNameSchema.nullable(),
    confirm: z.literal(true).optional(),
  })
  .refine(
    (v) => v.kind !== "delete" || (v.confirm === true && v.archive !== null),
    "delete-confirmation-required",
  );
export const LinuxBackupJobSchema = z.strictObject({
  id: uuid,
  planId: uuid,
  kind: z.enum(["create", "verify", "restore", "prune", "delete"]),
  status: z.enum(["running", "succeeded", "warning", "failed", "cancelled"]),
  stage: z.enum([
    "preparing",
    "archiving",
    "verifying",
    "restoring",
    "retention",
    "deleting",
    "compacting",
    "done",
  ]),
  archive: LinuxBackupArchiveNameSchema.nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  files: z.number().nonnegative(),
  bytes: z.number().nonnegative(),
  compressedBytes: z.number().nonnegative(),
  deduplicatedBytes: z.number().nonnegative(),
  error: z.string().nullable(),
  restorePath: z.string().nullable(),
});
export const LinuxBackupCapabilitySchema = z.strictObject({
  source: z.enum(["host", "simulated"]),
  available: z.boolean(),
  reason: z.enum([
    "ready",
    "linux-required",
    "root-required",
    "borg-missing",
    "borg-version",
    "development-mode",
  ]),
  version: z.string().nullable(),
  installationSupported: z.boolean(),
  targets: z.array(
    z.strictObject({
      id: z.string(),
      path: z.string(),
      device: z.string(),
      freeBytes: z.number().nullable(),
      available: z.boolean(),
    }),
  ),
  systemIncludes: z.array(z.string()),
  alwaysExcluded: z.array(z.string()),
});
export const LinuxBackupArchivesSchema = z.strictObject({
  limit: z.number().int().min(1).max(1000),
  archives: z.array(
    z.strictObject({
      name: LinuxBackupArchiveNameSchema,
      id: z.string(),
      createdAt: z.number(),
      verification: z.enum(["verified", "warning", "unknown"]),
      scope: z.enum(["system", "full", "custom"]).nullable(),
    }),
  ),
});
export const LinuxBackupActionRequestSchema = z
  .strictObject({
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    kind: z.enum(["create", "verify", "restore", "prune", "delete"]),
    archive: LinuxBackupArchiveNameSchema.nullable(),
    confirm: z.literal(true).optional(),
  })
  .refine(
    (v) => v.kind !== "delete" || (v.confirm === true && v.archive !== null),
    "delete-confirmation-required",
  );

export const LinuxBackupInstallRequestSchema = z.strictObject({
  confirm: z.literal(true),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export const LinuxBackupInstallEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("stage"),
    stage: z.enum(["refreshing", "installing", "checking"]),
  }),
  z.strictObject({
    type: z.literal("done"),
    ok: z.boolean(),
    error: z
      .enum([
        "BORG_PACKAGE_UNAVAILABLE",
        "BORG_PACKAGE_VERSION",
        "BORG_INSTALL_BUSY",
        "BORG_INSTALL_REFRESH_FAILED",
        "BORG_INSTALL_FAILED",
        "BORG_INSTALL_VERIFY_FAILED",
        "BORG_INSTALL_EVERYOS_VERSION",
      ])
      .nullable(),
  }),
]);
