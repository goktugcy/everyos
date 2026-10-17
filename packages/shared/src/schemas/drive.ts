import { z } from "zod";
import { FileNameSchema, FileRootIdSchema, RelativePathSchema } from "./files.ts";

/** Drive file ids, plus My Drive's root and the "Shared with me" folder. */
export const DriveIdSchema = z.string().regex(/^(?:root|shared|[A-Za-z0-9_-]{10,128})$/);

export const DriveClientInputSchema = z.strictObject({
  clientId: z
    .string()
    .trim()
    .max(256)
    .regex(/^[\w.-]+\.apps\.googleusercontent\.com$/),
  /** Omitted on update keeps the stored secret. */
  clientSecret: z
    .string()
    .trim()
    .min(8)
    .max(256)
    .regex(/^[\x21-\x7e]+$/)
    .optional(),
});

/** Google sends the browser back to a loopback address (Desktop app clients). */
export const DriveConnectSchema = z.strictObject({
  redirectUri: z.string().regex(/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/$/),
});

export const DriveCompleteSchema = z.strictObject({
  code: z
    .string()
    .min(4)
    .max(2048)
    .regex(/^[\x21-\x7e]+$/),
  state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});

export const DriveListQuerySchema = z.strictObject({
  folder: DriveIdSchema.default("root"),
  pageToken: z
    .string()
    .max(2048)
    .regex(/^[\x21-\x7e]+$/)
    .optional(),
});

export const DriveFolderCreateSchema = z.strictObject({
  parent: DriveIdSchema,
  name: FileNameSchema,
});

export const DriveRenameSchema = z.strictObject({ name: FileNameSchema });

/** Browser uploads into a Drive folder stream through EveryOS. */
export const DriveUploadQuerySchema = z.strictObject({
  parent: DriveIdSchema,
  name: FileNameSchema,
});

const FilesEndpoint = z.strictObject({
  kind: z.literal("files"),
  root: FileRootIdSchema,
  path: RelativePathSchema,
});
const DriveEndpoint = z.strictObject({ kind: z.literal("drive"), id: DriveIdSchema });

/** Copies between Drive and an EveryOS location, either way; the destination is a folder. */
export const DriveTransferRequestSchema = z.union([
  z.strictObject({ source: DriveEndpoint, destination: FilesEndpoint }),
  z.strictObject({ source: FilesEndpoint, destination: DriveEndpoint }),
]);
