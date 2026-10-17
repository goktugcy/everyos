import { z } from "zod";
import { DISK_UUID_PATTERN } from "../disks.ts";

export const DiskUuidSchema = z.string().regex(DISK_UUID_PATTERN);
const Volume = z.strictObject({
  uuid: DiskUuidSchema.nullable(),
  name: z.string().regex(/^[\w.:-]{1,64}$/),
  sizeBytes: z.number().int().nonnegative(),
  fsType: z.string().max(32).nullable(),
  label: z.string().max(128).nullable(),
  mountpoints: z.array(z.string().max(4096)).max(16),
  managed: z.boolean(),
  persistent: z.boolean(),
  supported: z.boolean(),
  readOnly: z.boolean(),
});
export const DiskListSchema = z.strictObject({
  source: z.enum(["host", "simulated"]),
  mountRoot: z.string().max(4096),
  disks: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[\w.:-]{1,64}$/),
        model: z.string().max(128).nullable(),
        sizeBytes: z.number().int().nonnegative(),
        transport: z.string().max(32).nullable(),
        removable: z.boolean(),
        system: z.boolean(),
        volumes: z.array(Volume).max(128),
      }),
    )
    .max(64),
  remembered: z
    .array(z.strictObject({ uuid: DiskUuidSchema, label: z.string().max(128).nullable() }))
    .max(64),
});
/** A tick from the agent's disk watcher: something below /dev/disk changed. */
export const DiskChangeSchema = z.strictObject({ at: z.number().int().nonnegative() });
export const DiskMountSchema = z.strictObject({ uuid: DiskUuidSchema, persistent: z.boolean() });
export const DiskUnmountSchema = z.strictObject({ uuid: DiskUuidSchema });
/** Browser request: unmounting repeats the UUID as confirmation. */
export const DiskUnmountRequestSchema = z.strictObject({
  uuid: DiskUuidSchema,
  confirm: DiskUuidSchema,
});
