import { z } from "zod";
import type { Permission } from "@everyos/shared";
import {
  FileLocationQuerySchema,
  FileListQuerySchema,
  FileSearchQuerySchema,
  TextWriteRequestSchema,
  MkdirRequestSchema,
  RenameRequestSchema,
  TransferRequestSchema,
  DeleteRequestSchema,
  TrashItemRequestSchema,
  TrashDeleteRequestSchema,
  FileRootIdSchema,
  RelativePathSchema,
  FileNameSchema,
  TrashEntrySchema,
} from "@everyos/shared/schemas";

const number = z.number().nonnegative();
const type = z.enum(["directory", "file", "symlink", "other"]);
const link = z
  .union([
    z.strictObject({ inside: z.literal(false) }),
    z.strictObject({ inside: z.literal(true), type: z.enum(["directory", "file", "other"]) }),
  ])
  .nullable();
const entry = z.strictObject({
  name: z.string(),
  type,
  size: number,
  modifiedAt: number,
  mode: z.string(),
  link,
});
const text = z.strictObject({
  content: z.string().max(1_048_576),
  etag: z.string(),
  size: number,
  modifiedAt: number,
});
const context = { locale: z.enum(["tr", "en"]), systemRoots: z.boolean() };
function file<S extends z.ZodRawShape, R extends z.ZodType>(
  params: z.ZodObject<S>,
  result: R,
  write = false,
) {
  return {
    kind: "unary" as const,
    params: params.extend(context),
    result,
    permission: (write ? "files:write" : "files:read") as Permission,
    mutating: write,
    allowSystemActor: false,
    timeoutMs: 120_000,
  };
}
const roots = z.array(
  z.strictObject({
    id: FileRootIdSchema,
    name: z.string(),
    kind: z.enum(["home", "location", "system"]),
    readOnly: z.boolean(),
    available: z.boolean(),
  }),
);
const transferId = z.string().uuid();
export const AGENT_FILE_OPERATIONS = {
  "files.roots": file(z.strictObject({}), roots),
  "files.list": file(
    FileListQuerySchema,
    z.strictObject({
      root: FileRootIdSchema,
      path: RelativePathSchema,
      entries: z.array(entry),
      truncated: z.boolean(),
    }),
  ),
  "files.properties": file(
    FileLocationQuerySchema,
    entry.extend({
      root: FileRootIdSchema,
      path: RelativePathSchema,
      changedAt: number,
      createdAt: number.nullable(),
      octal: z.string(),
      owner: z.string(),
      group: z.string(),
      children: number.nullable(),
    }),
  ),
  "files.search": file(
    FileSearchQuerySchema,
    z.strictObject({
      results: z.array(z.strictObject({ path: RelativePathSchema, name: z.string(), type })),
      truncated: z.boolean(),
    }),
  ),
  "files.text": file(FileLocationQuerySchema, text),
  "files.text.write": file(TextWriteRequestSchema, text, true),
  "files.mkdir": file(MkdirRequestSchema, z.null(), true),
  "files.rename": file(RenameRequestSchema, z.null(), true),
  "files.copy": file(TransferRequestSchema, z.null(), true),
  "files.move": file(TransferRequestSchema.omit({ name: true }), z.null(), true),
  "files.delete": file(DeleteRequestSchema, z.null(), true),
  "files.trash": file(
    z.strictObject({}),
    z.strictObject({ entries: z.array(TrashEntrySchema), truncated: z.boolean() }),
  ),
  "files.trash.restore": file(TrashItemRequestSchema, z.null(), true),
  "files.trash.delete": file(TrashDeleteRequestSchema, z.null(), true),
  "files.download.open": file(
    FileLocationQuerySchema,
    z.strictObject({ transferId, size: number, modifiedAt: number, name: z.string() }),
  ),
  "files.download.read": file(
    z.strictObject({
      transferId,
      offset: z.number().int().nonnegative(),
      length: z
        .number()
        .int()
        .min(1)
        .max(48 * 1024),
    }),
    z.strictObject({ data: z.string().max(64 * 1024) }),
  ),
  "files.download.close": file(z.strictObject({ transferId }), z.null()),
  "files.upload.open": file(
    z.strictObject({
      root: FileRootIdSchema,
      path: RelativePathSchema,
      name: FileNameSchema,
      length: z.number().int().nonnegative(),
      overwrite: z.boolean(),
    }),
    z.strictObject({ transferId }),
    true,
  ),
  "files.upload.write": file(
    z.strictObject({
      transferId,
      data: z
        .string()
        .max(64 * 1024)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    }),
    z.null(),
    true,
  ),
  "files.upload.close": file(z.strictObject({ transferId, commit: z.boolean() }), z.null(), true),
} as const;
