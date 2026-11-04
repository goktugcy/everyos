import { z } from "zod";
import {
  LinuxBackupArchivesSchema,
  LinuxBackupInstallEventSchema,
  LinuxBackupCapabilitySchema,
  LinuxBackupJobSchema,
  LinuxBackupSpecSchema,
  LinuxBackupStartSchema,
  LinuxBackupSelectionSchema,
} from "@everyos/shared/schemas";

const operation = <P extends z.ZodType, R extends z.ZodType>(
  params: P,
  result: R,
  mutating: boolean,
) => ({
  kind: "unary" as const,
  params,
  result,
  permission: "backups:restore" as const,
  allowSystemActor: false,
  mutating,
  timeoutMs: 30_000,
});
export const LINUX_BACKUP_OPERATIONS = {
  "backups.linux.install": {
    kind: "stream" as const,
    params: z.strictObject({}),
    event: LinuxBackupInstallEventSchema,
    permission: "system:manage" as const,
    allowSystemActor: false,
    mutating: true,
    maxDurationMs: 35 * 60_000,
  },
  "backups.linux.status": operation(z.strictObject({}), LinuxBackupCapabilitySchema, false),
  "backups.linux.preview": operation(
    LinuxBackupSelectionSchema,
    z.strictObject({ paths: z.array(z.string()), excludes: z.array(z.string()) }),
    false,
  ),
  "backups.linux.start": operation(LinuxBackupStartSchema, LinuxBackupJobSchema, true),
  "backups.linux.job": operation(
    z.strictObject({ id: z.string().uuid() }),
    LinuxBackupJobSchema,
    false,
  ),
  "backups.linux.cancel": operation(
    z.strictObject({ id: z.string().uuid() }),
    z.strictObject({ cancelled: z.boolean() }),
    true,
  ),
  "backups.linux.archives": operation(
    z.strictObject({ spec: LinuxBackupSpecSchema }),
    LinuxBackupArchivesSchema,
    false,
  ),
};
