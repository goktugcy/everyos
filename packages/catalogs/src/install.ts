import { createHmac, randomBytes } from "node:crypto";
import { AI_AGENT_CATALOG_ID, type AppInstallDefaults, type CatalogApp } from "@everyos/shared";
import {
  cleanCompose,
  CONFIG_PLACEHOLDER,
  inspectCompose,
  object,
  parseCompose,
  VARIABLE,
} from "./compose.ts";
import { CatalogError } from "./fetch.ts";
import { stringify } from "yaml";
import { validateField } from "./fields.ts";

export const APP_DATA_PLACEHOLDER = "{{otuken.appData}}";
export function managedProject(id: string): string {
  return `otk-${id.replaceAll("-", "")}`;
}
export function selectArchitecture(app: CatalogApp, architecture: string): CatalogApp {
  const compose = app.variants?.[architecture];
  if (!compose) return app;
  const inspected = inspectCompose(compose);
  return {
    ...app,
    ...inspected,
    compose,
    variables: inspected.variables.map((entry) => ({
      ...entry,
      ...app.variables.find((field) => field.key === entry.key),
    })),
  };
}

/** What an installation was prepared from; enough to prepare it again with other values. */
export interface InstallInputs {
  /** Every declared variable's resolved value, generated secrets included. */
  variables: Record<string, string>;
  /** Host ports the user fixed; others are allocated by Docker. */
  ports: { service: string; index: number; host: number }[];
  /** The account defaults (PUID, PGID, TZ) applied at installation, if any. */
  defaults: AppInstallDefaults | null;
}

/** Resolve only declared inputs. No process environment participates in interpolation. */
export function prepareInstall(
  app: CatalogApp,
  id: string,
  input: {
    variables: Record<string, string>;
    ports: { service: string; index: number; host: number }[];
  },
  defaults?: AppInstallDefaults,
): string {
  return prepareInstallValues(app, id, input, defaults).compose;
}

/** {@link prepareInstall}, also returning the resolved values so they can be kept. */
export function prepareInstallValues(
  app: CatalogApp,
  id: string,
  input: {
    variables: Record<string, string>;
    ports: { service: string; index: number; host: number }[];
  },
  defaults?: AppInstallDefaults,
): { compose: string; variables: Record<string, string> } {
  if (app.blockers.length) throw new CatalogError("unsupported-compose");
  const allowed = new Set(app.variables.map((entry) => entry.key));
  if (Object.keys(input.variables).some((key) => !allowed.has(key)))
    throw new CatalogError("unknown-variable");
  const vars = new Map<string, string>([
    ["AppID", id],
    ["APP_ID", id],
    ["APP_DATA_DIR", APP_DATA_PLACEHOLDER],
  ]);
  const declarations = [...app.variables].sort(
    (a, b) => Number(/^SERVICE_SUPABASE/.test(a.key)) - Number(/^SERVICE_SUPABASE/.test(b.key)),
  );
  const automatic = defaults
    ? { PUID: String(defaults.uid), PGID: String(defaults.gid), TZ: defaults.timezone }
    : {};
  for (const entry of declarations) {
    let value = input.variables[entry.key] ?? (automatic as Record<string, string>)[entry.key];
    if (!value && /^SERVICE_(URL|FQDN)_/.test(entry.key)) {
      const urlKey = entry.key.replace(/^SERVICE_FQDN_/, "SERVICE_URL_");
      const fqdnKey = entry.key.replace(/^SERVICE_URL_/, "SERVICE_FQDN_");
      const url = input.variables[urlKey],
        fqdn = input.variables[fqdnKey];
      if (entry.key === fqdnKey && url) {
        try {
          value = new URL(url).host;
        } catch {
          throw new CatalogError("invalid-field-value");
        }
      }
      if (entry.key === urlKey && fqdn) value = `http://${fqdn}`;
    }
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
      const size =
        entry.field?.type === "random"
          ? (entry.field.min ?? Math.min(32, entry.field.max ?? 32))
          : length;
      value =
        /^SERVICE_REALBASE64/.test(entry.key) || entry.field?.encoding === "base64"
          ? randomBytes(size).toString("base64")
          : randomBytes(size).toString("hex").slice(0, size);
      if (/^SERVICE_PASSWORDWITHSYMBOLS/.test(entry.key)) value = `${value.slice(0, -1)}!`;
      if (/^SERVICE_SUPABASE(ANON|SERVICE)_/.test(entry.key)) {
        const key = vars.get("SERVICE_PASSWORD_JWT");
        if (!key) throw new CatalogError("missing-jwt-signing-key");
        const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
          "base64url",
        );
        const now = Math.floor(Date.now() / 1000);
        const body = Buffer.from(
          JSON.stringify({
            iss: "supabase",
            role: entry.key.startsWith("SERVICE_SUPABASEANON_") ? "anon" : "service_role",
            iat: now,
            exp: now + 10 * 365 * 86400,
          }),
        ).toString("base64url");
        const signature = createHmac("sha256", key).update(`${header}.${body}`).digest("base64url");
        value = `${header}.${body}.${signature}`;
      }
    }
    if (value === undefined && !entry.secret && entry.default !== null) value = entry.default;
    if (value === undefined && entry.secret && entry.default === "") value = "";
    if (value === undefined || (entry.required && !value))
      throw new CatalogError("missing-variable");
    if (value.includes("\0")) throw new CatalogError("invalid-variable");
    if (value.includes(APP_DATA_PLACEHOLDER) || value.includes(CONFIG_PLACEHOLDER))
      throw new CatalogError("reserved-variable-value");
    if (entry.field) validateField(value, entry.field);
    vars.set(entry.key, value);
  }
  const doc = parseCompose(cleanCompose(app.compose));
  // Only EveryOS's own AI templates may join the internal AI network; catalogs lose the key above.
  if (app.source.catalogId === AI_AGENT_CATALOG_ID) {
    const network = parseCompose(app.compose)["x-otuken-ai-network"];
    if (network !== undefined) doc["x-otuken-ai-network"] = network;
  }
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
  if (defaults)
    for (const raw of Object.values(object(prepared.services))) {
      const environment = object(object(raw).environment);
      for (const [key, value] of Object.entries(automatic))
        if (key in environment && input.variables[key] === undefined) environment[key] = value;
    }
  const seen = new Set<string>();
  for (const port of input.ports) {
    const key = `${port.service}:${port.index}`;
    if (seen.has(key)) throw new CatalogError("duplicate-port");
    seen.add(key);
    const original = app.ports.find(
      (entry) => entry.service === port.service && entry.index === port.index,
    );
    if (!original) throw new CatalogError("unknown-port");
  }
  // Docker allocates omitted host ports atomically, including concurrent installs.
  for (const original of app.ports) {
    const port = input.ports.find(
      (entry) => entry.service === original.service && entry.index === original.index,
    );
    const service = object(object(prepared.services)[original.service]);
    if (!Array.isArray(service.ports)) throw new CatalogError("unknown-port");
    const existing = service.ports[original.index] as unknown;
    const hostIp =
      typeof existing === "string" && existing.split(":").length > 2
        ? existing
            .split(":")
            .slice(0, -2)
            .join(":")
            .replace(/^\[|\]$/g, "")
        : object(existing).host_ip;
    const mapping = { ...object(existing) };
    delete mapping.published;
    service.ports[original.index] = {
      ...mapping,
      target: original.container,
      ...(port ? { published: String(port.host) } : {}),
      protocol: original.protocol,
      ...(typeof hostIp === "string" ? { host_ip: hostIp } : {}),
    };
  }
  const result = stringify(prepared, { lineWidth: 0 });
  if (Buffer.byteLength(result) > 512 * 1024) throw new CatalogError("too-large");
  return {
    compose: result,
    variables: Object.fromEntries(
      app.variables.flatMap((entry) => {
        const value = vars.get(entry.key);
        return value === undefined ? [] : [[entry.key, value]];
      }),
    ),
  };
}
