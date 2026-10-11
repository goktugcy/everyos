import { isIP } from "node:net";
import { RE2JS } from "re2js";
import type { InstallField, LocalizedText } from "@everyos/shared";
import { object, text } from "./compose.ts";
import { CatalogError } from "./fetch.ts";

export function localized(value: unknown): LocalizedText {
  if (typeof value === "string") return { en: value.slice(0, 16_000) };
  return Object.fromEntries(
    Object.entries(object(value))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key.slice(0, 32), value.slice(0, 16_000)]),
  );
}
export function assetUrl(value: unknown, base: string): string | null {
  if (typeof value !== "string" || !value || value.length > 2048) return null;
  try {
    const url = new URL(
      /^https?:\/\//.test(value) ? value : value.replace(/^\//, ""),
      base.endsWith("/") ? base : `${base}/`,
    );
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function parseField(raw: unknown): InstallField {
  const entry = object(raw);
  const types = [
    "text",
    "password",
    "random",
    "boolean",
    "number",
    "email",
    "url",
    "ip",
    "fqdn",
    "fqdnip",
  ] as const;
  const type = types.find((value) => value === entry.type) ?? "text";
  const pattern = text(entry.regex);
  if (pattern) {
    if (pattern.length > 512) throw new CatalogError("unsupported-field-pattern");
    try {
      RE2JS.compile(pattern);
    } catch {
      throw new CatalogError("unsupported-field-pattern");
    }
  }
  const bound = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const min = bound(entry.min),
    max = bound(entry.max);
  if (min !== null && max !== null && min > max) throw new CatalogError("invalid-field-bounds");
  if (
    type === "random" &&
    ((min !== null && (!Number.isInteger(min) || min < 1 || min > 256)) ||
      (max !== null && (!Number.isInteger(max) || max < 1 || max > 256)))
  )
    throw new CatalogError("invalid-field-bounds");
  return {
    label: localized(entry.label),
    hint: localized(entry.hint),
    type,
    min,
    max,
    pattern,
    options: (Array.isArray(entry.options) ? entry.options : []).slice(0, 100).map((raw) => {
      const option = object(raw);
      const value =
        typeof option.value === "string" ||
        typeof option.value === "number" ||
        typeof option.value === "boolean"
          ? String(option.value)
          : "";
      return {
        label: text(option.label) ?? value,
        value,
      };
    }),
    encoding: entry.encoding === "base64" || entry.encoding === "hex" ? entry.encoding : null,
  };
}
export function validateField(value: string, field: InstallField): void {
  if (!value) return;
  const domain =
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
  let size = value.length;
  if (field.type === "number") {
    size = Number(value);
    if (!Number.isFinite(size)) throw new CatalogError("invalid-field-value");
  }
  if (field.type === "random" && field.encoding === "base64") {
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
      Buffer.from(value, "base64").toString("base64") !== value
    )
      throw new CatalogError("invalid-field-value");
    size = Buffer.from(value, "base64").length;
  }
  if (field.type === "random" && field.encoding === "hex" && !/^[a-fA-F0-9]+$/.test(value))
    throw new CatalogError("invalid-field-value");
  if (
    (field.min !== null && size < field.min) ||
    (field.max !== null && size > field.max) ||
    (field.pattern && !RE2JS.compile(field.pattern).matcher(value).find()) ||
    (field.options.length && !field.options.some((option) => option.value === value)) ||
    (field.type === "boolean" && value !== "true" && value !== "false") ||
    (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) ||
    (field.type === "ip" && !isIP(value)) ||
    (field.type === "fqdn" && !domain.test(value)) ||
    (field.type === "fqdnip" && !isIP(value) && !domain.test(value))
  )
    throw new CatalogError("invalid-field-value");
  if (field.type === "url") {
    try {
      if (!/^https?:$/.test(new URL(value).protocol)) throw new Error();
    } catch {
      throw new CatalogError("invalid-field-value");
    }
  }
}
