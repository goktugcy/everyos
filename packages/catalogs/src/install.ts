import { randomBytes } from "node:crypto";
import type { CatalogApp } from "@otuken/shared";
import { cleanCompose, object, parseCompose, VARIABLE } from "./compose.ts";
import { CatalogError } from "./fetch.ts";
import { stringify } from "yaml";

export const APP_DATA_PLACEHOLDER = "{{otuken.appData}}";
export function managedProject(id: string): string {
  return `otk-${id.replaceAll("-", "")}`;
}

/** Resolve only declared inputs. No process environment participates in interpolation. */
export function prepareInstall(
  app: CatalogApp,
  id: string,
  input: {
    variables: Record<string, string>;
    ports: { service: string; index: number; host: number }[];
  },
): string {
  if (app.blockers.length) throw new CatalogError("unsupported-compose");
  const allowed = new Set(app.variables.map((entry) => entry.key));
  if (Object.keys(input.variables).some((key) => !allowed.has(key)))
    throw new CatalogError("unknown-variable");
  const vars = new Map<string, string>([
    ["AppID", id],
    ["APP_ID", id],
    ["APP_DATA_DIR", APP_DATA_PLACEHOLDER],
  ]);
  for (const entry of app.variables) {
    let value = input.variables[entry.key];
    if (entry.generated && !value) {
      const length = /^SERVICE_(USER|LOWERCASEUSER)_/.test(entry.key)
        ? 16
        : Math.min(
            128,
            Number(
              entry.key.match(
                /^SERVICE_(?:PASSWORD(?:WITHSYMBOLS)?|BASE64|REALBASE64|HEX)_(32|64|128)_/,
              )?.[1],
            ) || 32,
          );
      value = /^SERVICE_REALBASE64/.test(entry.key)
        ? randomBytes(length).toString("base64")
        : randomBytes(length).toString("hex").slice(0, length);
      if (/^SERVICE_PASSWORDWITHSYMBOLS/.test(entry.key)) value = `${value.slice(0, -1)}!`;
    }
    if (value === undefined && !entry.secret && entry.default !== null) value = entry.default;
    if (value === undefined && entry.secret && entry.default === "") value = "";
    if (value === undefined || (entry.required && !value))
      throw new CatalogError("missing-variable");
    if (value.includes("\0")) throw new CatalogError("invalid-variable");
    vars.set(entry.key, value);
  }
  const doc = parseCompose(cleanCompose(app.compose));
  for (const raw of Object.values(object(doc.services))) {
    const service = object(raw);
    for (const [key, value] of Object.entries(object(service.environment))) {
      // Resolve bare entries once, so dollar signs in user credentials stay literal.
      if (value === null) object(service.environment)[key] = "${" + key + "}";
    }
  }
  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = value.replace(
        VARIABLE,
        (
          match: string,
          key: string | undefined,
          operator: string | undefined,
          fallback: string | undefined,
          bare: string | undefined,
        ) => {
          if (match === "$$") return "$";
          const name = key ?? bare ?? "";
          const replacement = vars.get(name);
          if (operator?.includes("+")) return replacement ? (fallback ?? "") : "";
          if (replacement !== undefined && (!operator?.startsWith(":") || replacement))
            return replacement;
          if (operator?.includes("-")) return fallback ?? "";
          throw new CatalogError("missing-variable");
        },
      );
      // Compose performs a second interpolation pass; user values must remain literal.
      return result.replaceAll("$", () => "$$");
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => {
          if (key.includes("$") || key.includes(APP_DATA_PLACEHOLDER))
            throw new CatalogError("variable-in-key");
          return [key, resolve(child)];
        }),
      );
    return value;
  };
  const prepared = object(resolve(doc));
  const seen = new Set<string>();
  for (const port of input.ports) {
    const key = `${port.service}:${port.index}`;
    if (seen.has(key)) throw new CatalogError("duplicate-port");
    seen.add(key);
    const original = app.ports.find(
      (entry) => entry.service === port.service && entry.index === port.index,
    );
    if (!original) throw new CatalogError("unknown-port");
    const service = object(object(prepared.services)[port.service]);
    if (!Array.isArray(service.ports)) throw new CatalogError("unknown-port");
    const existing = service.ports[port.index] as unknown;
    const hostIp =
      typeof existing === "string" && existing.split(":").length > 2
        ? existing
            .split(":")
            .slice(0, -2)
            .join(":")
            .replace(/^\[|\]$/g, "")
        : object(existing).host_ip;
    service.ports[port.index] = {
      ...object(existing),
      target: original.container,
      published: String(port.host),
      protocol: original.protocol,
      ...(typeof hostIp === "string" ? { host_ip: hostIp } : {}),
    };
  }
  const result = stringify(prepared, { lineWidth: 0 });
  if (Buffer.byteLength(result) > 512 * 1024) throw new CatalogError("too-large");
  return result;
}
