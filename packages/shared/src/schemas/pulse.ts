import { z } from "zod";
import { MAX_SHELF_ITEMS } from "../preferences.ts";
import { FileRootIdSchema, RelativePathSchema } from "./files.ts";

export const ShelfItemSchema = z.strictObject({
  root: FileRootIdSchema,
  /** Path inside the root; never the root itself. */
  path: RelativePathSchema.refine((value) => value.length > 0, "empty-path"),
  kind: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative().nullable(),
  addedAt: z.number().int().nonnegative(),
});

/**
 * The menu bar pulse: whether it is shown and how it opens, where files
 * dropped on it are uploaded, and the shelf (docs/pulse.md).
 */
export const PulsePreferencesSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  openOnHover: z.boolean(),
  /** Upload target for files dropped on the pulse; null = the first writable location. */
  destination: z.strictObject({ root: FileRootIdSchema, path: RelativePathSchema }).nullable(),
  shelf: z.array(ShelfItemSchema).max(MAX_SHELF_ITEMS),
});

export type ShelfItem = z.infer<typeof ShelfItemSchema>;
export type PulsePreferences = z.infer<typeof PulsePreferencesSchema>;
