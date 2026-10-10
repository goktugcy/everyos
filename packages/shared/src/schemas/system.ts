import { z } from "zod";
import { CAPABILITY_IDS, CAPABILITY_REASONS, DATA_SOURCES } from "../system.ts";

export const CapabilityStatusSchema = z.object({
  available: z.boolean(),
  reason: z.enum(CAPABILITY_REASONS).optional(),
});

export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const SystemInfoSchema = z.object({
  source: z.enum(DATA_SOURCES),
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  kernel: z.string(),
  os: z.object({
    id: z.string().nullable(),
    name: z.string(),
    version: z.string().nullable(),
    prettyName: z.string(),
  }),
  cpu: z.object({
    model: z.string(),
    cores: z.number().int().nonnegative(),
  }),
  memory: z.object({
    totalBytes: z.number().nonnegative(),
  }),
  uptimeSeconds: z.number().nonnegative(),
  bootTime: z.number().nonnegative(),
  hardware: z.object({
    model: z.string().nullable(),
    isRaspberryPi: z.boolean(),
  }),
  capabilities: z.record(z.enum(CAPABILITY_IDS), CapabilityStatusSchema),
  collectedAt: z.number(),
});

export type SystemInfo = z.infer<typeof SystemInfoSchema>;
