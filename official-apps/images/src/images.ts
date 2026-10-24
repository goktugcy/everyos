import type { FileHandle } from "@everyos/app-sdk";
import { parse } from "exifr";

export const IMAGE_TYPES = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".ico",
  ".svg",
];
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const isImage = (file: Pick<FileHandle, "name" | "kind">) =>
  file.kind === "file" && /\.(jpe?g|png|gif|webp|avif|bmp|ico|svg)$/i.test(file.name);
export interface ImagePreferences {
  ids: string[];
  current: string | null;
  interval: number;
}
export function imagePreferences(value: unknown): ImagePreferences {
  const data = value as Partial<ImagePreferences> | null;
  const ids = Array.isArray(data?.ids)
    ? [
        ...new Set(
          data.ids.filter(
            (id): id is string => typeof id === "string" && /^[\w-]{1,128}$/.test(id),
          ),
        ),
      ].slice(0, 100)
    : [];
  return {
    ids,
    current:
      typeof data?.current === "string" && ids.includes(data.current)
        ? data.current
        : (ids[0] ?? null),
    interval: [2000, 5000, 10000, 30000].includes(data?.interval ?? 0) ? data!.interval! : 5000,
  };
}
export interface ImageMetadata {
  tags: Array<{ key: string; value: string | number }>;
  failed: boolean;
}
const TAGS = [
  "Make",
  "Model",
  "LensModel",
  "DateTimeOriginal",
  "ExposureTime",
  "FNumber",
  "ISO",
  "FocalLength",
  "Orientation",
  "latitude",
  "longitude",
];
/** Parse a bounded selected file; binary EXIF and arbitrary objects never enter the interface. */
export async function imageMetadata(data: ArrayBuffer, name: string): Promise<ImageMetadata> {
  if (data.byteLength > MAX_IMAGE_BYTES) throw new RangeError(`too-large:${MAX_IMAGE_BYTES}`);
  if (!/\.(jpe?g|png|webp|avif)$/i.test(name)) return { tags: [], failed: false };
  try {
    const parsed = (await parse(data)) as Record<string, unknown> | undefined;
    const tags = TAGS.flatMap<ImageMetadata["tags"][number]>((key) => {
      const value = parsed?.[key];
      if (value instanceof Date && Number.isFinite(value.getTime()))
        return [{ key, value: value.toISOString() }];
      return typeof value === "string"
        ? [{ key, value: value.slice(0, 1000) }]
        : typeof value === "number" && Number.isFinite(value)
          ? [{ key, value }]
          : [];
    });
    return { tags, failed: false };
  } catch {
    return { tags: [], failed: true };
  }
}
export const zoomed = (value: number) => Math.max(0.1, Math.min(8, value));
export const rotated = (value: number) => ((value % 360) + 360) % 360;
