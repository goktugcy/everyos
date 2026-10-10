import type { CatalogApp, InstallRisk } from "@otuken/shared";
import { parse, stringify } from "yaml";
import { CatalogError } from "./fetch.ts";

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
export function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function parseCompose(input: string): Record<string, unknown> {
  if (Buffer.byteLength(input) > 512 * 1024) throw new CatalogError("too-large");
  const result: unknown = parse(input, { maxAliasCount: 50, uniqueKeys: true });
  const doc = object(result);
  const services = object(doc.services);
  if (!Object.keys(services).length || Object.keys(services).length > 50)
    throw new CatalogError("invalid-compose");
  return doc;
}

function values(
  value: unknown,
  visit: (value: string) => void,
  depth = 0,
  seen = new Set<object>(),
): void {
  if (depth > 32) throw new CatalogError("invalid-compose");
  if (typeof value === "string") visit(value);
  else if (value !== null && typeof value === "object") {
    if (seen.has(value)) throw new CatalogError("recursive-compose");
    seen.add(value);
    for (const child of Object.values(value)) values(child, visit, depth + 1, seen);
    seen.delete(value);
  }
}

export const VARIABLE =
  /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const SECRET = /PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|JWT/i;
const PLATFORM = new Set(["AppID", "APP_ID", "APP_DATA_DIR"]);

export function inspectCompose(
  compose: string,
): Pick<CatalogApp, "images" | "risks" | "blockers" | "variables" | "ports" | "mounts"> {
  const doc = parseCompose(compose);
  const risks = new Set<InstallRisk>();
  const blockers = new Set<string>();
  const images: string[] = [];
  const ports: CatalogApp["ports"] = [];
  const mounts: CatalogApp["mounts"] = [];
  const variables = new Map<string, CatalogApp["variables"][number]>();
  const forbiddenTop = ["include", "configs", "secrets"];
  for (const key of forbiddenTop) if (doc[key] !== undefined) blockers.add(`compose.${key}`);
  for (const section of ["volumes", "networks"]) {
    for (const resource of Object.values(object(doc[section]))) {
      const entry = object(resource);
      if (entry.external || entry.name || entry.driver || entry.driver_opts)
        blockers.add(`compose.${section}.external-or-driver`);
    }
  }
  for (const [name, raw] of Object.entries(object(doc.services))) {
    const service = object(raw);
    if (service.container_name !== undefined) blockers.add("compose.container_name");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) blockers.add("compose.service-name");
    for (const key of [
      "build",
      "env_file",
      "extends",
      "provider",
      "post_start",
      "pre_start",
      "pre_stop",
      "label_file",
      "use_api_socket",
      "volumes_from",
      "credential_spec",
      "develop",
    ])
      if (service[key] !== undefined) blockers.add(`compose.${key}`);
    if (Object.keys(object(service.deploy)).length && object(service.deploy).mode === "global")
      blockers.add("compose.swarm");
    const image = text(service.image);
    if (!image) blockers.add("compose.image-required");
    else {
      images.push(image);
      const last = image.split("/").at(-1) ?? "";
      if (
        !image.includes("@sha256:") &&
        (!last.includes(":") || last.endsWith(":latest") || image.includes("$"))
      )
        risks.add("unpinned-image");
    }
    if (service.privileged) risks.add("privileged");
    if (service.network_mode === "host") risks.add("host-network");
    else if (service.network_mode && service.network_mode !== "none")
      blockers.add("compose.network_mode");
    if (service.pid === "host" || service.ipc === "host") risks.add("host-pid");
    if (service.cgroup === "host") risks.add("host-pid");
    if (typeof service.ipc === "string" && service.ipc.startsWith("container:"))
      blockers.add("compose.ipc");
    if (typeof service.pid === "string" && service.pid.startsWith("container:"))
      blockers.add("compose.pid");
    if (
      service.devices ||
      service.device_cgroup_rules ||
      (object(service.deploy).resources &&
        object(object(object(service.deploy).resources).reservations).devices)
    )
      risks.add("devices");
    if (strings(service.cap_add).length) risks.add("cap-add");
    if (strings(service.security_opt).some((value) => /unconfined|disable/i.test(value)))
      risks.add("security-opt-unconfined");
    for (const volume of Array.isArray(service.volumes) ? service.volumes : []) {
      const entry = object(volume);
      const parts = typeof volume === "string" ? volume.split(":") : [];
      if (entry.content !== undefined) blockers.add("compose.volume-content");
      const source =
        typeof volume === "string"
          ? parts.length > 1
            ? (parts[0] ?? null)
            : null
          : text(entry.source);
      const target =
        typeof volume === "string" ? (parts.length > 1 ? parts[1] : parts[0]) : text(entry.target);
      if (target)
        mounts.push({
          service: name,
          source,
          target,
          kind:
            entry.type === "bind" ||
            (source && /^(\/|\.|~|\$|\{\{otuken\.appData\}\})/.test(source))
              ? "bind"
              : "volume",
          readOnly: entry.read_only === true || (parts[2]?.split(",").includes("ro") ?? false),
        });
      if (source && /docker\.sock|podman\.sock/.test(source)) risks.add("docker-socket");
      if (
        source &&
        (source.startsWith("/") || source.startsWith(".") || source.includes("$")) &&
        !/^\$\{?APP_DATA_DIR\}?\//.test(source)
      )
        risks.add("sensitive-host-path");
      if (source?.startsWith(".") || source?.startsWith("~")) blockers.add("compose.relative-bind");
      if (
        entry.type === "bind" &&
        source &&
        !source.startsWith("/") &&
        !source.startsWith("${APP_DATA_DIR}") &&
        !source.startsWith("{{otuken.appData}}")
      )
        blockers.add("compose.relative-bind");
    }
    for (const [index, port] of (Array.isArray(service.ports) ? service.ports : []).entries()) {
      const entry = object(port);
      let container: number;
      let host: number | null;
      let protocol: "tcp" | "udp" = "tcp";
      if (typeof port === "string" || typeof port === "number") {
        const [mapping = "", type = "tcp"] = String(port).split("/");
        const parts = mapping.split(":");
        container = Number(parts.at(-1));
        host = parts.length > 1 ? Number(parts.at(-2)) || null : null;
        if (type === "udp") protocol = "udp";
        else if (type !== "tcp") blockers.add("compose.port-protocol");
      } else {
        container = Number(entry.target);
        host = Number(entry.published) || null;
        if (entry.protocol === "udp") protocol = "udp";
        else if (entry.protocol && entry.protocol !== "tcp") blockers.add("compose.port-protocol");
      }
      if (!Number.isInteger(container) || container < 1 || container > 65535)
        blockers.add("compose.port-range");
      else ports.push({ service: name, index, container, host, protocol });
    }
    const environment = Array.isArray(service.environment)
      ? Object.fromEntries(
          strings(service.environment).map((value) => {
            const split = value.indexOf("=");
            return split < 0 ? [value, null] : [value.slice(0, split), value.slice(split + 1)];
          }),
        )
      : object(service.environment);
    for (const [key, value] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) blockers.add("compose.environment-key");
      if (
        typeof value === "string" &&
        value &&
        !value.includes("$") &&
        (SECRET.test(key) || /[a-z]+:\/\/[^/:\s]+:[^/@\s]+@/i.test(value))
      )
        risks.add("default-secret");
      // Bare entries must not inherit the agent's process environment.
      if (value === null)
        variables.set(key, {
          key,
          required: true,
          secret: SECRET.test(key),
          default: null,
          generated:
            /^(SERVICE_(PASSWORD|USER|LOWERCASEUSER|BASE64|REALBASE64|HEX)|OTUKEN_SECRET_)/.test(
              key,
            ),
        });
    }
  }
  values(doc, (value) => {
    for (const match of value.matchAll(VARIABLE)) {
      if (match[0] === "$$") continue;
      const key = match[1] ?? match[4] ?? "";
      if (PLATFORM.has(key)) continue;
      const fallback = match[2]?.includes("-") ? (match[3] ?? "") : null;
      const current = variables.get(key);
      variables.set(key, {
        key,
        required: (current?.required ?? false) || fallback === null,
        secret: SECRET.test(key),
        default: fallback,
        generated:
          /^(SERVICE_(PASSWORD|USER|LOWERCASEUSER|BASE64|REALBASE64|HEX)|OTUKEN_SECRET_)/.test(key),
      });
    }
  });
  return {
    images: [...new Set(images)],
    risks: [...risks],
    blockers: [...blockers],
    variables: [...variables.values()],
    ports,
    mounts,
  };
}

/** Stable YAML strips source-only extensions and prevents fixed container names. */
export function cleanCompose(input: string): string {
  const doc = parseCompose(input);
  delete doc.name;
  delete doc.version;
  for (const key of Object.keys(doc)) if (key.startsWith("x-")) delete doc[key];
  for (const raw of Object.values(object(doc.services))) {
    const service = object(raw);
    delete service.container_name;
    for (const key of Object.keys(service)) if (key.startsWith("x-")) delete service[key];
    const environment = Array.isArray(service.environment)
      ? Object.fromEntries(
          strings(service.environment).map((entry) => {
            const split = entry.indexOf("=");
            return split < 0 ? [entry, null] : [entry.slice(0, split), entry.slice(split + 1)];
          }),
        )
      : object(service.environment);
    if (service.environment !== undefined) service.environment = environment;
  }
  return stringify(doc, { lineWidth: 0 });
}
