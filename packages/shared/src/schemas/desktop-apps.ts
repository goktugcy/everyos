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

/* `/api/app-sdk`: calls made for a running app instance (docs/app-sdk/architecture.md). */

export const AppInstanceOpenSchema = z.strictObject({
  appId,
  kind: z.enum(["window", "widget"]),
  widgetId: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .optional(),
});

const storageKey = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => [...value].every((char) => char.charCodeAt(0) >= 0x20));

export const AppStorageKeySchema = z.strictObject({ key: storageKey });
export const AppStorageSetSchema = z.strictObject({ key: storageKey, value: z.json() });
export const AppStorageKeysSchema = z.strictObject({ prefix: z.string().max(256) });

const grantPath = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0") && !value.split("/").some((part) => part === ".."));

export const AppFileGrantSchema = z.strictObject({
  items: z
    .array(z.strictObject({ root: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), path: grantPath }))
    .min(1)
    .max(64),
  write: z.boolean(),
  persist: z.boolean(),
});

export const AppFileSaveSchema = z.strictObject({
  root: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  path: grantPath,
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !/[/\\\0]/.test(value) && value !== "." && value !== ".."),
  persist: z.boolean(),
});

export const AppFileHandleParamSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

export const AppFileReadQuerySchema = z.strictObject({
  offset: z.coerce.number().int().min(0),
  length: z.coerce
    .number()
    .int()
    .min(1)
    .max(512 * 1024),
});

export const AppFileWriteQuerySchema = z.strictObject({
  offset: z.coerce.number().int().min(0),
  done: z.enum(["true", "false"]),
});

export const AppFileListQuerySchema = z.strictObject({ path: grantPath.default("") });

export const AppFileChildSchema = z.strictObject({
  path: grantPath.refine((value) => value.length > 0),
  create: z.enum(["file", "directory"]).nullable(),
});
