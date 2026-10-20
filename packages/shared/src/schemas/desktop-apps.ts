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

export const AppNotificationSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  body: z.string().max(200),
  level: z.enum(["info", "success", "warning", "critical"]),
  tag: z
    .string()
    .regex(/^[\w.:-]{1,64}$/)
    .nullable(),
});

export const AppHostCallSchema = z.strictObject({ input: z.json() });

export const DesktopAppUserSettingsSchema = z.strictObject({ notifications: z.boolean() });

export const AppDiskUsageInputSchema = z.strictObject({
  handle: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  path: z
    .string()
    .max(4096)
    .refine((value) => !value.split("/").some((part) => part === ".."))
    .default(""),
});

/* ------------------------------------------------------------------ network */

const ports = z
  .array(z.int().min(1).max(65_535))
  .min(1)
  .max(32)
  .refine((list) => new Set(list).size === list.length, "Ports repeat");

/** A host name with at least two labels and a non-numeric top label (IPs belong in CIDR rules). */
const hostName =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const DesktopAppNetworkRuleCreateSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("host"),
    pattern: z
      .string()
      .trim()
      .toLowerCase()
      .refine((value) => hostName.test(value.replace(/^\*\./, "")), "Not a host name"),
    ports,
    appId: appId.nullable().default(null),
    note: z.string().trim().max(200).nullable().default(null),
  }),
  z.strictObject({
    kind: z.literal("cidr"),
    /** Checked precisely by the API (address family and prefix length). */
    pattern: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[0-9a-f:.]{2,45}\/\d{1,3}$/),
    ports,
    appId: appId.nullable().default(null),
    note: z.string().trim().max(200).nullable().default(null),
  }),
]);

export const DesktopAppNetworkRuleIdSchema = z.strictObject({ id: z.uuid() });

const target = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine(
    (value) =>
      hostName.test(value) ||
      z.ipv4().safeParse(value).success ||
      z.ipv6().safeParse(value).success,
    "Not a host",
  );

const httpHeader = z.tuple([
  z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/),
  z
    .string()
    .max(8192)
    .regex(/^[^\r\n\0]*$/),
]);

/** Bounds mirror NET_LIMITS in @everyos/app-sdk. */
export const AppNetHttpInputSchema = z.strictObject({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  url: z.string().min(8).max(8192),
  headers: z.array(httpHeader).max(64).default([]),
  body: z
    .union([
      z.strictObject({ text: z.string().max(192 * 1024) }),
      z.strictObject({ base64: z.base64().max(Math.ceil((192 * 1024) / 3) * 4) }),
    ])
    .nullable()
    .default(null),
  followRedirects: z.boolean().default(false),
  verifyTls: z.boolean().default(true),
  timeoutMs: z.int().min(1000).max(60_000).default(30_000),
});

export const AppNetDnsInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .refine(
      (value) =>
        /^(?=.{1,253}$)(_?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*_?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.?$/.test(
          value,
        ) ||
        z.ipv4().safeParse(value).success ||
        z.ipv6().safeParse(value).success,
      "Not a DNS name",
    ),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA", "SRV", "PTR"]),
  server: z.union([z.ipv4(), z.ipv6()]).nullable().default(null),
  serverPort: z.int().min(1).max(65_535).default(53),
  timeoutMs: z.int().min(1000).max(15_000).default(5000),
});

export const AppNetTlsInputSchema = z.strictObject({
  host: target,
  port: z.int().min(1).max(65_535).default(443),
  servername: z.string().trim().toLowerCase().regex(hostName).nullable().default(null),
  timeoutMs: z.int().min(1000).max(30_000).default(10_000),
});

export const AppMonitorSaveSchema = z.strictObject({
  id: z.uuid().nullable().default(null),
  name: z.string().trim().min(1).max(80),
  url: z.string().min(8).max(2048),
  method: z.enum(["GET", "HEAD"]),
  intervalSeconds: z.int().min(60).max(86_400),
  timeoutMs: z.int().min(1000).max(30_000),
  expectStatus: z
    .strictObject({ min: z.int().min(100).max(599), max: z.int().min(100).max(599) })
    .refine((range) => range.min <= range.max, "Empty range"),
  keyword: z.string().min(1).max(200).nullable().default(null),
  downAfter: z.int().min(1).max(5),
  verifyTls: z.boolean(),
  notify: z.boolean(),
  enabled: z.boolean(),
});

export const AppMonitorIdSchema = z.strictObject({ id: z.uuid() });

export const AppMonitorHistorySchema = z.strictObject({
  id: z.uuid(),
  since: z.int().min(0).optional(),
  limit: z.int().min(1).max(5000).default(1000),
});
