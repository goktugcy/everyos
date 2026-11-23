import { isNetworkRoot } from "../sharing.ts";
import { z } from "zod";
import { FileLocationQuerySchema, FileNameSchema, RelativePathSchema } from "./files.ts";

export const SharingIdSchema = z.string().uuid();
export const SharingHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|[a-fA-F0-9:]+)$/)
  .refine((v) => !v.startsWith("-") && !v.includes(".."));
const Name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((v) => !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127));
const Login = z
  .string()
  .max(128)
  .refine((v) => !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127));
const RemotePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (v) =>
      !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
      !v.split("/").some((s) => s === ".." || s === "."),
  );
export const SharingConnectionInputSchema = z
  .strictObject({
    name: Name,
    protocol: z.enum(["nfs", "smb", "sftp"]),
    host: SharingHostSchema,
    port: z.number().int().min(1).max(65535),
    remotePath: RemotePath,
    mountName: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
      .optional(),
    username: Login.default(""),
    readOnly: z.boolean().default(true),
    enabled: z.boolean().default(true),
    persistent: z.boolean().default(false),
    automount: z.boolean().default(true),
    version: z.enum(["4.2", "4.1", "4", "3", "3.1.1", "3.0", "2.1", "sftp"]),
    fingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
      .nullable()
      .default(null),
    password: z
      .string()
      .min(1)
      .max(1024)
      .refine((v) => !/[\0\r\n]/.test(v))
      .optional(),
    privateKey: z
      .string()
      .min(32)
      .max(32 * 1024)
      .optional(),
    passphrase: z.string().max(1024).optional(),
    domain: z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9_.-]*$/)
      .optional(),
    confirm: z.literal(true),
  })
  .superRefine((v, c) => {
    const invalid =
      v.protocol === "nfs"
        ? !v.remotePath.startsWith("/") ||
          !["4.2", "4.1", "4", "3"].includes(v.version) ||
          v.password !== undefined ||
          v.privateKey !== undefined
        : v.protocol === "smb"
          ? !/^[A-Za-z0-9_.$ -]{1,80}$/.test(v.remotePath) ||
            !["3.1.1", "3.0", "2.1"].includes(v.version) ||
            !v.username ||
            v.privateKey !== undefined
          : !v.remotePath.startsWith("/") || v.version !== "sftp" || !v.username || !v.fingerprint;
    if (invalid) c.addIssue({ code: "custom", message: "Invalid protocol settings" });
  });
export const SharingProbeSchema = z.strictObject({
  host: SharingHostSchema,
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["nfs", "smb", "sftp"]),
});
export const SharingControlSchema = z.strictObject({
  action: z.enum(["connect", "disconnect"]),
  confirm: z.literal(true),
});
export const SharingClientSchema = z
  .string()
  .max(64)
  .regex(/^[a-fA-F0-9:.]+(?:\/\d{1,3})?$/)
  .refine((v) => !/\/0$/.test(v) && v !== "0.0.0.0" && v !== "::");
export const SharingLinuxUserSchema = z
  .string()
  .regex(/^[a-z_][a-z0-9_-]{0,31}\$?$/)
  .refine((v) => v !== "root");
export const SharingFolderInputSchema = z
  .strictObject({
    name: Name.regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/),
    protocol: z.enum(["nfs", "smb"]),
    ...FileLocationQuerySchema.shape,
    readOnly: z.boolean().default(true),
    enabled: z.boolean().default(true),
    clients: z.array(SharingClientSchema).max(32).default([]),
    users: z.array(SharingLinuxUserSchema).max(32).default([]),
    confirm: z.literal(true),
  })
  .refine((v) => v.protocol !== "nfs" || v.clients.length > 0, "NFS requires explicit clients")
  .refine(
    (v) => v.root !== "home" && !v.root.startsWith("sys-") && !isNetworkRoot(v.root),
    "Only authorized local Linux folders can be exported",
  );
export const QuickShareInputSchema = z
  .strictObject({
    name: Name,
    direction: z.enum(["send", "receive"]),
    ...FileLocationQuerySchema.shape,
    paths: z
      .array(RelativePathSchema.refine((v) => v.length > 0))
      .max(100)
      .default([]),
    lifetimeMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(15),
    oneTime: z.boolean().default(false),
    password: z.string().min(8).max(256).optional(),
    maxDownloads: z.number().int().min(1).max(1000).default(10),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 ** 3)
      .default(1024 ** 3),
  })
  .refine((v) => v.direction !== "send" || v.paths.length > 0);
export const QuickAccessSchema = z.strictObject({ password: z.string().max(256).optional() });
export const QuickUploadSchema = z.strictObject({ name: FileNameSchema });
export const AgentMountInputSchema = z.strictObject({
  id: SharingIdSchema,
  name: Name,
  protocol: z.enum(["nfs", "smb"]),
  host: SharingHostSchema,
  port: z.number().int().min(1).max(65535),
  remotePath: RemotePath,
  mountName: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
    .optional(),
  readOnly: z.boolean(),
  persistent: z.boolean(),
  automount: z.boolean(),
  enabled: z.boolean(),
  version: z.enum(["4.2", "4.1", "4", "3", "3.1.1", "3.0", "2.1"]),
  username: Login,
  password: z
    .string()
    .min(1)
    .max(1024)
    .refine((v) => !/[\0\r\n]/.test(v))
    .optional(),
  domain: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_.-]*$/)
    .optional(),
});
export const AgentExportInputSchema = SharingFolderInputSchema.safeExtend({ id: SharingIdSchema });
const Service = z.strictObject({
  protocol: z.enum(["nfs", "smb", "sftp", "discovery", "nfs-client", "smb-client"]),
  installed: z.boolean(),
  active: z.boolean(),
  installSupported: z.boolean(),
});
const Mount = z.strictObject({
  id: z.string().nullable(),
  owner: z.string().nullable(),
  protocol: z.enum(["nfs", "smb"]),
  source: z.string().max(2048),
  target: z.string().max(2048),
  readOnly: z.boolean(),
  mounted: z.boolean(),
  managed: z.boolean(),
  reachable: z.boolean().nullable(),
});
export const SharingHostStatusSchema = z.strictObject({
  externalExports: z
    .array(z.strictObject({ path: z.string().max(4096), client: z.string().max(256) }))
    .max(256)
    .default([]),
  sshPorts: z.array(z.number().int().min(1).max(65535)).max(16).default([]),
  exports: z.array(z.strictObject({ id: SharingIdSchema, active: z.boolean() })).max(256),
  source: z.enum(["host", "simulated"]),
  supported: z.boolean(),
  services: z.array(Service).max(6),
  mounts: z.array(Mount).max(256),
  addresses: z.array(z.string().max(256)).max(64),
  reason: z.string().max(128).nullable(),
  installation: z
    .strictObject({
      state: z.enum(["running", "succeeded", "failed"]),
      protocol: z.string().max(32),
      reason: z.string().max(128).nullable(),
    })
    .nullable(),
});
export const SharingIdParamsSchema = z.strictObject({ id: SharingIdSchema });
