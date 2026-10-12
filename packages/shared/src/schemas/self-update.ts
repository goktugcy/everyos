import { z } from "zod";
import { RELEASE_JOB_STATES, RELEASE_VERSION_PATTERN } from "../self-update.ts";
import { BackupIdSchema } from "./backups.ts";
export const ReleaseVersionSchema = z.string().max(32).regex(RELEASE_VERSION_PATTERN);
export const ReleaseInstallSchema = z.strictObject({
  version: ReleaseVersionSchema,
  backupId: BackupIdSchema,
  confirm: z.literal(true),
});
export const SelfUpdateInstallRequestSchema = z.strictObject({
  version: ReleaseVersionSchema,
  backupId: BackupIdSchema,
  // Accept older clients during upgrades without requiring or using their password.
  password: z.string().min(1).max(1024).optional(),
  confirm: z.literal(true),
});
export const ReleaseJobSchema = z.strictObject({
  id: z.string().uuid(),
  version: ReleaseVersionSchema,
  previousVersion: ReleaseVersionSchema,
  backupId: BackupIdSchema,
  state: z.enum(RELEASE_JOB_STATES),
  createdAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable(),
  error: z.string().max(500).nullable(),
});
export const SelfUpdateStatusSchema = z.strictObject({
  source: z.literal("host"),
  installedVersion: ReleaseVersionSchema,
  architecture: z.enum(["arm64", "amd64"]).nullable(),
  configured: z.boolean(),
  reason: z.enum(["development-mode", "not-linux", "not-configured"]).nullable(),
  checkedAt: z.number().int().nonnegative().nullable(),
  available: z
    .strictObject({
      version: ReleaseVersionSchema,
      minVersion: ReleaseVersionSchema,
      schemaVersion: z.number().int().positive(),
      notes: z.string().max(8000),
      publishedAt: z.number().int().nonnegative(),
    })
    .nullable(),
  job: ReleaseJobSchema.nullable(),
});
