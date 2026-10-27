import { htmlProblems, inspectPackage, type PackageLimits } from "@everyos/app-package";
import { z } from "zod";
import { RegistryHttpError } from "./storage.ts";

export const COMMUNITY_LIMITS: PackageLimits = {
  packedBytes: 8 * 1024 * 1024,
  unpackedBytes: 32 * 1024 * 1024,
  entries: 2000,
  manifestBytes: 16 * 1024,
};
const Messages: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());
const textKeys = (value: unknown, prefix = ""): string[] => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RegistryHttpError(422, "invalid-locale");
  return Object.entries(value).flatMap(([key, item]) => {
    if (typeof item === "string")
      return [`${prefix}${key}`.replace(/_(zero|one|two|few|many|other)$/, "")];
    return textKeys(item, `${prefix}${key}.`);
  });
};
export async function inspectCommunityPackage(bytes: Buffer) {
  const { manifest } = await inspectPackage(bytes, COMMUNITY_LIMITS);
  const locales = new Map<string, Set<string>>();
  const localePaths = new Set(
    manifest.locales?.supported.map((locale) => `${manifest.locales!.path}/${locale}.json`) ?? [],
  );
  await inspectPackage(bytes, COMMUNITY_LIMITS, async (entry) => {
    const html = entry.path.endsWith(".html");
    if (!html && !localePaths.has(entry.path)) return;
    if (entry.size > (html ? 256 : 512) * 1024)
      throw new RegistryHttpError(422, "text-file-too-large");
    const chunks: Buffer[] = [];
    for await (const chunk of entry.content) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    if (html) {
      if (htmlProblems(text).length) throw new RegistryHttpError(422, "html-policy");
    } else {
      try {
        locales.set(entry.path, new Set(textKeys(Messages.parse(JSON.parse(text)))));
      } catch {
        throw new RegistryHttpError(422, "invalid-locale");
      }
    }
  });
  if (manifest.locales) {
    const base = locales.get(`${manifest.locales.path}/${manifest.locales.default}.json`)!;
    for (const keys of locales.values())
      if ([...base].some((key) => !keys.has(key)))
        throw new RegistryHttpError(422, "incomplete-locale");
  }
  return manifest;
}
/** Store assets are raster-only; SVG remains allowed inside the sandboxed app package. */
export function imageMime(bytes: Buffer): string {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (width > 0 && height > 0 && width <= 8192 && height <= 8192) return "image/png";
  }
  if (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.length &&
    ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))
  )
    return "image/webp";
  throw new RegistryHttpError(422, "invalid-raster-image");
}
