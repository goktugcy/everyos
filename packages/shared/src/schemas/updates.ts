import { z } from "zod";

export const PackageNameSchema = z.string().regex(/^[a-z0-9][a-z0-9+.-]{0,127}$/);

export const PackageInfoSchema = z.object({
  name: z.string().max(128),
  installedVersion: z.string().max(128).nullable(),
  candidateVersion: z.string().max(128).nullable(),
  security: z.boolean(),
  section: z.string().max(64).nullable(),
  installedSize: z.number().nonnegative().nullable(),
  summary: z.string().max(200).nullable(),
  description: z.string().max(4000).nullable(),
  homepage: z.string().max(256).nullable(),
  maintainer: z.string().max(256).nullable(),
  origins: z.array(z.string().max(128)).max(16),
});

export const AptRefreshResultSchema = z.object({
  source: z.enum(["host", "simulated"]),
  ok: z.boolean(),
  busy: z.boolean(),
  output: z.string().max(64 * 1024),
});

export const AptUpgradeParamsSchema = z.strictObject({
  /** null: everything upgradable. */
  packages: z.array(PackageNameSchema).min(1).max(500).nullable(),
});

export const AptUpgradeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("line"), text: z.string().max(2000) }),
  z.object({
    type: z.literal("done"),
    ok: z.boolean(),
    exitCode: z.number().int().nullable(),
    upgraded: z.number().int().nonnegative().nullable(),
    busy: z.boolean(),
  }),
]);

/** `POST /api/updates/upgrade` */
export const UpgradeRequestSchema = z.union([
  z.strictObject({
    packages: z.array(PackageNameSchema).min(1).max(500),
    confirm: z.literal(true),
  }),
  z.strictObject({ all: z.literal(true), confirm: z.literal(true) }),
]);
