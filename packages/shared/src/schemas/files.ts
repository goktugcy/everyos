import { z } from "zod";
import { MAX_TEXT_FILE_BYTES } from "../files.ts";
import { isShelfTemporary, MAX_SHELF_ITEMS } from "../preferences.ts";

/** UTF-8 byte length (file names are limited to 255 bytes, not characters). */
function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const FileRootIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

/** Relative path inside a root; "" is the root. Never absolute, never "." or ".." segments. */
export const RelativePathSchema = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0") && !value.startsWith("/"), "invalid-path")
  .refine(
    (value) =>
      value
        .split("/")
        .filter(Boolean)
        .every((segment) => segment !== "." && segment !== ".." && utf8Length(segment) <= 255),
    "invalid-path",
  );

/** One new file or folder name. */
export const FileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\0") &&
      value !== "." &&
      value !== ".." &&
      utf8Length(value) <= 255,
    "invalid-name",
  );

const location = { root: FileRootIdSchema, path: RelativePathSchema };

export const FileLocationQuerySchema = z.strictObject(location);

export const FileListQuerySchema = z.strictObject({
  ...location,
  hidden: z.enum(["true", "false"]).optional(),
});

export const FileDownloadQuerySchema = z.strictObject({
  ...location,
  /** Preview raster images in place (never HTML or SVG). */
  inline: z.enum(["true"]).optional(),
  /**
   * A shelf file dragged out onto the computer: deleted for good once it was downloaded whole.
   * Ignored for anything that is not a shelf file (isShelfTemporary).
   */
  discard: z.enum(["true"]).optional(),
});

export const FileSearchQuerySchema = z.strictObject({
  ...location,
  q: z.string().trim().min(1).max(128),
});

export const FileUploadQuerySchema = z.strictObject({
  ...location,
  name: FileNameSchema,
  overwrite: z.enum(["true", "false"]).optional(),
});

export const TextWriteRequestSchema = z.strictObject({
  ...location,
  content: z.string().max(MAX_TEXT_FILE_BYTES),
  /** Version read before editing; null creates a new file (fails if it exists). */
  etag: z.string().max(64).nullable(),
});

export const MkdirRequestSchema = z.strictObject({ ...location, name: FileNameSchema });

export const RenameRequestSchema = z.strictObject({ ...location, name: FileNameSchema });

const PathListSchema = z.array(RelativePathSchema).min(1).max(500);

export const TransferRequestSchema = z.strictObject({
  root: FileRootIdSchema,
  paths: PathListSchema,
  destination: z.strictObject(location),
  /** Copy of a single item under another name (duplicate). */
  name: FileNameSchema.optional(),
});

export const DeleteRequestSchema = z.strictObject({
  root: FileRootIdSchema,
  paths: PathListSchema,
  /** Explicit confirmation; the UI asks before deleting. */
  confirm: z.literal(true),
});

export const TrashEntrySchema = z.strictObject({
  id: z.string().uuid(),
  root: FileRootIdSchema,
  path: RelativePathSchema.min(1),
  name: FileNameSchema,
  type: z.enum(["directory", "file", "symlink", "other"]),
  size: z.number().int().nonnegative(),
  deletedAt: z.number().nonnegative(),
});

export const TrashItemRequestSchema = z.strictObject({
  root: FileRootIdSchema,
  ids: z.array(z.string().uuid()).min(1).max(500),
});

export const TrashDeleteRequestSchema = TrashItemRequestSchema.extend({ confirm: z.literal(true) });

/** `POST /api/files/shelf/discard`: files the shelf holds itself, deleted for good. */
export const ShelfDiscardRequestSchema = z.strictObject({
  paths: z
    .array(
      RelativePathSchema.refine(
        (path) => isShelfTemporary({ root: "home", path }),
        "not-a-shelf-file",
      ),
    )
    .min(1)
    .max(MAX_SHELF_ITEMS),
});

/** `PUT /api/files/settings` (administrators). */
export const FileSettingsSchema = z.strictObject({ systemRoots: z.boolean() });
