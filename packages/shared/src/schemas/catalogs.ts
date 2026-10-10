import { z } from "zod";
import { APP_ACTIONS, CATALOG_FORMATS } from "../catalogs.ts";

export const CatalogIdSchema = z.string().uuid();
export const CatalogRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  url: z
    .url()
    .max(2048)
    .refine((value) => /^https?:\/\/[^/?#@]+(?:[/?][^#]*)?$/.test(value)),
  format: z.enum(CATALOG_FORMATS).default("auto"),
  allowPrivate: z.boolean().default(false),
});
export const CatalogUpdateSchema = z.strictObject({ enabled: z.boolean() });

export const AppInstallRequestSchema = z.strictObject({
  appId: z
    .string()
    .max(210)
    .regex(/^[a-f0-9-]{36}:[a-z0-9_.-]{1,160}$/),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/),
  variables: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(4096))
    .refine((value) => Object.keys(value).length <= 128)
    .default({}),
  ports: z
    .array(
      z.strictObject({
        service: z.string().max(64),
        index: z.number().int().min(0).max(255),
        host: z.number().int().min(1024).max(65535),
      }),
    )
    .max(128)
    .default([]),
  acknowledgeRisks: z.boolean().default(false),
});
export const ManagedAppRunSchema = z.strictObject({
  id: z.string().uuid(),
  action: z.enum(APP_ACTIONS),
  compose: z.string().max(512 * 1024),
  riskOverride: z.boolean(),
});
export const ManagedAppResultSchema = z.strictObject({
  source: z.enum(["host", "simulated"]),
  ok: z.boolean(),
  rollback: z.enum(["not-needed", "succeeded", "failed"]),
});
