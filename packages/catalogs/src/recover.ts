import { isDeepStrictEqual } from "node:util";
import type { AppInstallDefaults, CatalogApp } from "@everyos/shared";
import { cleanCompose, object, parseCompose, VARIABLE } from "./compose.ts";
import { prepareInstallValues, type InstallInputs } from "./install.ts";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const AUTOMATIC = ["PUID", "PGID", "TZ"] as const;

/**
 * The template string as a pattern: each interpolation becomes a capture of its variable's value
 * (`${A:+x}` matches "x" or nothing, since it says nothing about A's value).
 */
function pattern(template: string): { regex: RegExp; names: string[] } | null {
  const names: string[] = [];
  let source = "";
  let last = 0;
  for (const match of template.matchAll(new RegExp(VARIABLE.source, "g"))) {
    source += escape(template.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[0] === "$$") {
      source += "\\$";
      continue;
    }
    const [, key, operator, fallback, bare] = match;
    if (operator?.includes("+")) source += `(?:${escape(fallback ?? "")})?`;
    else {
      names.push(key ?? bare ?? "");
      source += "([\\s\\S]*?)";
    }
  }
  if (!names.length) return null;
  source += escape(template.slice(last));
  return { regex: new RegExp(`^${source}$`), names };
}

/**
 * Recovers what an installation was prepared from out of its stored Compose file, for
 * installations made before EveryOS kept their inputs. Values are read where the template
 * interpolates them; the result is used only if preparing the template again reproduces the
 * stored file exactly, so a recovery can never silently change an application.
 */
export function recoverInputs(app: CatalogApp, id: string, stored: string): InstallInputs | null {
  const template = parseCompose(cleanCompose(app.compose));
  for (const raw of Object.values(object(template.services))) {
    const environment = object(object(raw).environment);
    for (const [key, value] of Object.entries(environment))
      if (value === null) environment[key] = "${" + key + "}";
  }
  const actual = parseCompose(stored);
  const values = new Map<string, string>();
  let consistent = true;
  const walk = (expected: unknown, found: unknown, path: string[]): void => {
    if (!consistent) return;
    if (typeof expected === "string") {
      const compiled = pattern(expected);
      if (!compiled || typeof found !== "string") return;
      const match = compiled.regex.exec(found);
      if (!match) return;
      compiled.names.forEach((name, index) => {
        const value = match[index + 1] ?? "";
        const known = values.get(name);
        if (known !== undefined && known !== value) consistent = false;
        values.set(name, value);
      });
      return;
    }
    if (Array.isArray(expected) && Array.isArray(found)) {
      expected.forEach((item, index) => walk(item, found[index], [...path, String(index)]));
      return;
    }
    if (expected && typeof expected === "object" && found && typeof found === "object") {
      for (const [key, child] of Object.entries(expected)) {
        // Port mappings are rebuilt from the template; fixed host ports are read below.
        if (key === "ports" && path[0] === "services" && path.length === 2) continue;
        walk(child, (found as Record<string, unknown>)[key], [...path, key]);
      }
    }
  };
  walk(template, actual, []);
  if (!consistent) return null;

  const declared = new Set(app.variables.map((entry) => entry.key));
  const variables = Object.fromEntries([...values].filter(([key]) => declared.has(key)));
  const ports = app.ports.flatMap((port) => {
    const mapping = object(
      (object(object(actual.services)[port.service]).ports as unknown[] | undefined)?.[port.index],
    );
    const host = Number(mapping.published);
    return Number.isInteger(host) && host > 0
      ? [{ service: port.service, index: port.index, host }]
      : [];
  });
  // Account defaults replaced literal PUID/PGID/TZ values; read back what was applied.
  const applied: Partial<Record<(typeof AUTOMATIC)[number], string>> = {};
  for (const [name, raw] of Object.entries(object(actual.services))) {
    const environment = object(object(raw).environment);
    const original = object(object(object(template.services)[name]).environment);
    for (const key of AUTOMATIC)
      if (typeof environment[key] === "string" && environment[key] !== original[key])
        applied[key] ??= environment[key];
  }
  const defaults: AppInstallDefaults | null = Object.keys(applied).length
    ? {
        source: "host",
        uid: Number(applied.PUID ?? 0),
        gid: Number(applied.PGID ?? 0),
        timezone: applied.TZ ?? "Etc/UTC",
      }
    : null;
  try {
    const prepared = prepareInstallValues(app, id, { variables, ports }, defaults ?? undefined);
    if (!isDeepStrictEqual(parseCompose(prepared.compose), actual)) return null;
    return { variables: prepared.variables, ports, defaults };
  } catch {
    return null;
  }
}
