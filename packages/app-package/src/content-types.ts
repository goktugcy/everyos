/**
 * The static web assets a package may contain, with the type they are served as. Anything else is
 * refused when packing and when installing, so a package can never carry an executable or a file
 * that a browser would interpret differently than its name says.
 */
export const PACKAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  map: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
  // Data files libraries load by name (pdf.js: character maps, Type 1 fonts, colour profiles);
  // served as plain bytes, which browsers never render or run.
  bcmap: "application/octet-stream",
  pfb: "application/octet-stream",
  icc: "application/octet-stream",
};

export function contentTypeOf(path: string): string | null {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return PACKAGE_CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}
