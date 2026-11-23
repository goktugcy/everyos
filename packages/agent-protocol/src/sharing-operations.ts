import { z } from "zod";
import {
  AgentMountInputSchema,
  AgentExportInputSchema,
  SharingHostStatusSchema,
  SharingIdSchema,
  SharingLinuxUserSchema,
  FileLocationQuerySchema,
} from "@everyos/shared/schemas";
import type { OperationContract } from "./operations.ts";

const read = {
  permission: "files:read",
  allowSystemActor: false,
  mutating: false,
  kind: "unary",
  timeoutMs: 15000,
} as const;
const write = {
  permission: "system:manage",
  allowSystemActor: false,
  mutating: true,
  kind: "unary",
  timeoutMs: 60000,
} as const;
const Empty = z.strictObject({});
const Id = z.strictObject({ id: SharingIdSchema });
export const NETWORK_SHARING_OPERATIONS = {
  "files.share.inspect": {
    ...read,
    params: FileLocationQuerySchema.extend({ readOnly: z.boolean() }),
    result: z.strictObject({ path: z.string().max(4096), device: z.number(), inode: z.number() }),
  },
  "sharing.status": { ...read, params: Empty, result: SharingHostStatusSchema },
  "sharing.mount.apply": {
    ...write,
    params: AgentMountInputSchema,
    result: z.strictObject({ target: z.string().max(2048) }),
  },
  "sharing.mount.control": {
    ...write,
    params: Id.extend({ action: z.enum(["connect", "disconnect"]) }),
    result: z.null(),
  },
  "sharing.mount.access": {
    ...read,
    mutating: true,
    timeoutMs: 30000,
    params: Id,
    result: z.null(),
  },
  "sharing.mount.remove": { ...write, params: Id, result: z.null() },
  "sharing.export.apply": { ...write, params: AgentExportInputSchema, result: z.null() },
  "sharing.export.remove": { ...write, params: Id, result: z.null() },
  "sharing.service": {
    ...write,
    params: z.strictObject({
      protocol: z.enum(["nfs", "smb", "sftp", "discovery"]),
      action: z.enum(["start", "reload"]),
    }),
    result: z.null(),
  },
  "sharing.install": {
    ...write,
    params: z.strictObject({
      protocol: z.enum(["nfs", "smb", "sftp", "discovery", "nfs-client", "smb-client"]),
    }),
    result: z.null(),
  },
  "sharing.smb.account": {
    ...write,
    params: z.strictObject({
      username: SharingLinuxUserSchema,
      password: z
        .string()
        .min(12)
        .max(1024)
        .refine((v) => !/[\0\r\n]/.test(v)),
    }),
    result: z.null(),
  },
  "sharing.discover": {
    ...read,
    params: Empty,
    result: z.strictObject({
      available: z.boolean(),
      services: z
        .array(
          z.strictObject({
            name: z.string().max(256),
            host: z.string().max(256),
            port: z.number().int().min(1).max(65535),
            protocol: z.enum(["nfs", "smb", "sftp"]),
          }),
        )
        .max(100),
    }),
  },
} as const satisfies Record<string, OperationContract>;
