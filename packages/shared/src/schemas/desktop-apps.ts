import { z } from "zod";

/*
 * Request bodies of `/api/desktop-apps` (docs/app-sdk/architecture.md). Capability names and app
 * identifiers are checked against @everyos/app-manifest by the API.
 */

const appId = z
  .string()
  .min(5)
  .max(128)
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,6}$/);
const capability = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z.:-]*[a-z]$/);
const version = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);

export const DesktopAppRegistryIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9-]{3,64}$/);

export const DesktopAppRegistryCreateSchema = z.strictObject({
  kind: z.enum(["community", "private"]),
  name: z.string().trim().min(1).max(64),
  url: z
    .url()
    .max(2048)
    .refine((value) => /^https?:\/\/[^/?#@]+(?:[/?][^#]*)?$/.test(value)),
  publicKey: z.string().min(40).max(512),
  /** The fingerprint the administrator compared with the registry's; must match the key. */
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  /** Bearer token for a private registry; sealed at rest, never returned. */
  token: z.string().min(8).max(4096).optional(),
  allowPrivate: z.boolean().default(false),
});

export const DesktopAppRegistryUpdateSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    token: z.string().min(8).max(4096).nullable().optional(),
  })
  .refine((value) => value.enabled !== undefined || value.token !== undefined);

export const DesktopAppInstallSchema = z.strictObject({
  registryId: DesktopAppRegistryIdSchema,
  appId,
  /** A specific version; the newest compatible one otherwise. */
  version: version.optional(),
  /** Sensitive and elevated capabilities the installer approves (standard ones need no approval). */
  approve: z.array(capability).max(32).default([]),
});

export const DesktopAppUpdateSchema = z.strictObject({
  version: version.optional(),
  approve: z.array(capability).max(32).default([]),
});

export const DesktopAppIdParamSchema = z.strictObject({ appId });

export const DesktopAppStateSchema = z.strictObject({ enabled: z.boolean() });

export const DesktopAppUninstallSchema = z.strictObject({ confirm: z.literal(true) });
