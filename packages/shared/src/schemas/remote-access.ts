import { z } from "zod";
import { REMOTE_ACCESS_PROVIDERS } from "../remote-access.ts";
import { isShortcutUrl } from "../preferences.ts";

export const RemoteAccessProviderSchema = z.enum(REMOTE_ACCESS_PROVIDERS);
export const RemoteAccessParamsSchema = z.strictObject({ provider: RemoteAccessProviderSchema });
const managementUrl = z
  .string()
  .max(2048)
  .refine(
    (value) => isShortcutUrl(value) && /^https:\/\/[^/?#]+\/?$/i.test(value),
    "https-management-origin",
  )
  .nullable();
export const RemoteAccessSettingsSchema = z.strictObject({
  managementUrl,
  acceptDNS: z.boolean(),
  acceptRoutes: z.boolean(),
});
export const RemoteAccessConfigureSchema = RemoteAccessSettingsSchema.extend({
  confirm: z.literal(true),
});
export const RemoteAccessConnectRequestSchema = z.strictObject({
  confirm: z.literal(true),
  credential: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine((v) => ![...v].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127))
    .optional(),
  acknowledgeConflicts: z.boolean(),
});
export const RemoteAccessConnectSchema = RemoteAccessParamsSchema.extend({
  settings: RemoteAccessSettingsSchema,
  credential: RemoteAccessConnectRequestSchema.shape.credential,
  acknowledgeConflicts: z.boolean(),
});
export const RemoteAccessInstallRequestSchema = z.strictObject({
  confirm: z.literal(true),
  configureRepository: z.boolean(),
});
export const RemoteAccessInstallSchema = RemoteAccessParamsSchema.extend({
  configureRepository: z.boolean(),
});
export const RemoteAccessNodeSchema = z.strictObject({
  provider: RemoteAccessProviderSchema,
  source: z.enum(["host", "simulated"]),
  installed: z.boolean(),
  available: z.boolean(),
  reason: z
    .enum(["not-installed", "daemon-unavailable", "permission-denied", "unsupported"])
    .nullable(),
  state: z.enum([
    "connected",
    "connecting",
    "disconnected",
    "needs-login",
    "needs-approval",
    "unknown",
  ]),
  version: z.string().max(128).nullable(),
  hostName: z.string().max(256).nullable(),
  addresses: z.array(z.string().max(128)).max(16),
  managementUrl: z.string().max(2048).nullable(),
  dnsEnabled: z.boolean().nullable(),
  acceptsRoutes: z.boolean().nullable(),
  routes: z.array(z.string().max(128)).max(128),
  defaultRoute: z.boolean().nullable(),
  advertisesExitNode: z.boolean().nullable(),
  routeVisibility: z.boolean(),
  peers: z.strictObject({
    total: z.number().int().nonnegative(),
    online: z.number().int().nonnegative(),
  }),
  installationSupported: z.boolean(),
});
export const RemoteAccessInstallJobSchema = z.strictObject({
  provider: RemoteAccessProviderSchema,
  status: z.enum(["running", "succeeded", "failed"]),
  stage: z.enum(["preparing", "refreshing", "installing", "checking", "done"]),
  error: z.string().max(128).nullable(),
  startedAt: z.number().nonnegative(),
  finishedAt: z.number().nonnegative().nullable(),
});
export const RemoteAccessSnapshotSchema = z.strictObject({
  providers: z.array(RemoteAccessNodeSchema).max(8),
  installations: z.array(RemoteAccessInstallJobSchema).max(8),
});
export const RemoteAccessPeersSchema = z.strictObject({
  peers: z
    .array(
      z.strictObject({
        name: z.string().max(256).nullable(),
        addresses: z.array(z.string().max(128)).max(8),
        online: z.boolean().nullable(),
        connection: z.enum(["direct", "relay", "idle", "unknown"]),
        lastSeen: z.number().nonnegative().nullable(),
        rxBytes: z.number().nonnegative(),
        txBytes: z.number().nonnegative(),
      }),
    )
    .max(500),
});
