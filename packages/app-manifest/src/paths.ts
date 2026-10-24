/**
 * Paths inside a package: relative, `/`-separated, ASCII URL-safe segments, never `.`/`..`, so a
 * path means the same file in the archive, on disk and in a runtime URL.
 */
const SEGMENT = /^[A-Za-z0-9_@+~-][A-Za-z0-9._@+~-]{0,127}$/;

export function isPackagePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  const segments = value.split("/");
  return (
    segments.length <= 16 &&
    segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")
  );
}

export function extensionOf(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
