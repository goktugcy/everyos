import { createHash } from "node:crypto";
import type { CatalogApp, CatalogFormat } from "@everyos/shared";
import { stringify } from "yaml";
import { readZip, safePath } from "./archive.ts";
import {
  cleanCompose,
  CONFIG_PLACEHOLDER,
  inspectCompose,
  object,
  parseCompose,
  strings,
  text,
} from "./compose.ts";
import { CatalogError, type CatalogFetcher } from "./fetch.ts";
import { assetUrl, localized, parseField } from "./fields.ts";

export interface CatalogSnapshot {
  ref: string;
  apps: CatalogApp[];
  skipped: { path: string; reason: string }[];
}
function parseJson(value: string): Record<string, unknown> {
  return object(JSON.parse(value));
}
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .slice(0, 160) || "app"
  );
}
function scalar(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  throw new CatalogError("invalid-scalar");
}

function normalize(
  catalogId: string,
  ref: string,
  path: string,
  format: CatalogFormat,
  nativeId: string,
  input: string,
  extra: Record<string, unknown> = {},
): CatalogApp {
  const doc = parseCompose(input);
  const meta = { ...object(doc["x-casaos"]), ...extra };
  const base = text(meta.assetBase) ?? "https://invalid.invalid/";
  const prepared = structuredClone(doc);
  if (format === "coolify") {
    const files: { name: string; content: string }[] = [];
    for (const raw of Object.values(object(prepared.services))) {
      const service = object(raw);
      delete service.exclude_from_hc;
      if (Array.isArray(service.volumes))
        service.volumes = service.volumes.map((raw: unknown) => {
          const volume = { ...object(raw) };
          if (typeof volume.content === "string") {
            if (typeof volume.target !== "string" || !volume.target.startsWith("/"))
              throw new CatalogError("invalid-inline-files");
            const name = `config${files.length}`;
            files.push({ name, content: volume.content });
            return {
              type: "bind",
              source: `${CONFIG_PLACEHOLDER}/${name}`,
              target: volume.target,
              read_only: true,
            };
          }
          if (
            volume.is_directory === true &&
            typeof volume.source === "string" &&
            /^\.\/[A-Za-z0-9_./-]+$/.test(volume.source) &&
            !volume.source.split("/").includes("..")
          ) {
            volume.source = "${APP_DATA_DIR}/" + volume.source.slice(2);
            delete volume.is_directory;
            return volume;
          }
          return raw;
        });
      if (!Array.isArray(service.ports) || !service.ports.length) {
        const env = Array.isArray(service.environment)
          ? strings(service.environment).join("\n")
          : JSON.stringify(service.environment ?? {});
        const port = Number(
          env.match(/SERVICE_(?:URL|FQDN)_[A-Za-z0-9_]*_([0-9]{2,5})(?:[^A-Za-z0-9_]|$)/)?.[1],
        );
        if (Number.isInteger(port) && port > 0 && port <= 65535) service.ports = [String(port)];
      }
    }
    if (files.length) prepared["x-otuken-files"] = files;
  }
  if (format === "casaos-source" || format === "casaos-v2") {
    for (const raw of Object.values(object(prepared.services))) {
      const service = object(raw);
      if (Array.isArray(service.volumes))
        service.volumes = service.volumes.map((raw: unknown) => {
          const rewrite = (value: string) =>
            value.replace(/^\/DATA\/AppData\//, "${APP_DATA_DIR}/");
          if (typeof raw === "string") return rewrite(raw);
          const entry = { ...object(raw) };
          if (typeof entry.source === "string") entry.source = rewrite(entry.source);
          return entry;
        });
    }
  }
  const compose = cleanCompose(stringify(prepared));
  const inspected = inspectCompose(compose);
  const services = object(doc.services);
  const main = text(meta.main) ?? Object.keys(services)[0] ?? nativeId;
  const mainImage = text(object(services[main]).image) ?? inspected.images[0] ?? nativeId;
  const imageRepository = mainImage
    .replace(/@[^@]+$/, "")
    .replace(/:[^/:]+$/, "")
    .toLowerCase();
  const name = localized(meta.title ?? meta.name ?? nativeId);
  const simpleName = (name.en ?? Object.values(name)[0] ?? nativeId)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  // Form generators are hints; risk flags always come from the Compose document.
  for (const field of Array.isArray(meta.form_fields) ? meta.form_fields : []) {
    const entry = object(field);
    const key = text(entry.env_variable);
    const variable = inspected.variables.find((item) => item.key === key);
    if (variable) {
      variable.field = parseField(entry);
      if (entry.type === "random") variable.generated = true;
      if (entry.type === "password" || entry.type === "random") variable.secret = true;
      if (entry.required === true) variable.required = true;
      if (entry.default !== undefined && !variable.secret) variable.default = scalar(entry.default);
    }
  }
  for (const entry of inspected.variables)
    if (!entry.field && /^SERVICE_(URL|FQDN)_/.test(entry.key))
      entry.field = parseField({ type: entry.key.startsWith("SERVICE_URL_") ? "url" : "fqdnip" });
  const variants = Object.fromEntries(
    Object.entries(object(meta.composeVariants)).map(([arch, compose]) => {
      if (typeof compose !== "string") throw new CatalogError("invalid-compose-variant");
      return [
        arch,
        normalize(catalogId, ref, path, format, nativeId, compose, { ...meta, composeVariants: {} })
          .compose,
      ];
    }),
  );
  const webPort =
    inspected.ports.find(
      (port) =>
        port.service === main && port.protocol === "tcp" && port.host === Number(meta.port_map),
    ) ?? inspected.ports.find((port) => port.service === main && port.protocol === "tcp");
  return {
    id: `${catalogId}:${nativeId}`,
    nativeId,
    logicalKey: `${imageRepository}:${simpleName}`,
    name,
    description: localized(
      meta.description ?? meta.short_desc ?? meta.slogan ?? meta.tagline ?? "",
    ),
    categories: [
      ...new Set([...strings(meta.categories), ...(text(meta.category)?.split(",") ?? [])]),
    ]
      .map((value) => value.trim().toLowerCase())
      .slice(0, 32),
    icon: text(meta.icon),
    screenshots: strings(meta.screenshots ?? meta.screenshot_link)
      .slice(0, 12)
      .map((url) => assetUrl(url, base))
      .filter((url): url is string => url !== null),
    links: {
      documentation: assetUrl(meta.documentation ?? meta.docs, base),
      website: assetUrl(meta.website, base),
      repository: assetUrl(meta.repo ?? meta.repository, base),
    },
    notes: localized(object(meta.tips).before_install ?? meta.pre_install_notes),
    web: {
      ...(webPort ? { service: main, port: webPort.container } : {}),
      path:
        text(meta.index) &&
        String(meta.index).startsWith("/") &&
        !String(meta.index).startsWith("//")
          ? String(meta.index)
          : "/",
      scheme: meta.scheme === "https" ? "https" : "http",
    },
    variants,
    contentHash: text(meta.content_hash),
    ...(text(meta.cacheKey) ? { cacheKey: String(meta.cacheKey) } : {}),
    version: text(meta.version),
    architectures: strings(meta.architectures ?? meta.supported_architectures),
    source: { catalogId, format, ref, path },
    compose,
    ...inspected,
    risks: [
      ...new Set([
        ...inspected.risks,
        ...Object.values(variants).flatMap((variant) => inspectCompose(variant).risks),
      ]),
    ],
  };
}

function runtipiCompose(
  dynamic: Record<string, unknown>,
  config: Record<string, unknown>,
  architecture?: string,
): string {
  if (dynamic.schemaVersion !== 2 || !Array.isArray(dynamic.services))
    throw new CatalogError("unsupported-runtipi-schema");
  const selected = new Map(dynamic.services.map((raw) => [text(object(raw).name), object(raw)]));
  for (const raw of Array.isArray(dynamic.overrides) ? dynamic.overrides : []) {
    const override = object(raw);
    if (override.architecture !== architecture) continue;
    for (const raw of Array.isArray(override.services) ? override.services : []) {
      const service = object(raw),
        name = text(service.name);
      if (!name || !selected.has(name)) throw new CatalogError("invalid-runtipi-override");
      selected.set(name, { ...selected.get(name), ...service });
    }
  }
  const services: Record<string, unknown> = {};
  const fields: Record<string, string> = {
    command: "command",
    entrypoint: "entrypoint",
    dependsOn: "depends_on",
    networkMode: "network_mode",
    extraHosts: "extra_hosts",
    dns: "dns",
    hostname: "hostname",
    ulimits: "ulimits",
    sysctls: "sysctls",
    capAdd: "cap_add",
    capDrop: "cap_drop",
    devices: "devices",
    deploy: "deploy",
    pid: "pid",
    privileged: "privileged",
    securityOpt: "security_opt",
    readOnly: "read_only",
    user: "user",
    workingDir: "working_dir",
    shmSize: "shm_size",
    tty: "tty",
    stdinOpen: "stdin_open",
    stopSignal: "stop_signal",
    stopGracePeriod: "stop_grace_period",
    logging: "logging",
    extraLabels: "labels",
  };
  const known = new Set([
    "name",
    "image",
    "isMain",
    "internalPort",
    "addPorts",
    "environment",
    "volumes",
    "healthCheck",
    "addToMainNetwork",
    ...Object.keys(fields),
  ]);
  for (const raw of selected.values()) {
    const source = object(raw);
    if (Object.keys(source).some((key) => !known.has(key)))
      throw new CatalogError("unsupported-runtipi-field");
    const name = text(source.name);
    if (!name || Object.hasOwn(services, name)) throw new CatalogError("invalid-runtipi-service");
    const service: Record<string, unknown> = { image: source.image, restart: "unless-stopped" };
    for (const [from, to] of Object.entries(fields))
      if (source[from] !== undefined) service[to] = source[from];
    if (source.environment !== undefined) {
      if (!Array.isArray(source.environment)) throw new CatalogError("invalid-runtipi-environment");
      service.environment = Object.fromEntries(
        source.environment.map((raw) => {
          const entry = object(raw);
          if (typeof entry.key !== "string" || typeof entry.value !== "string")
            throw new CatalogError("invalid-runtipi-environment");
          return [entry.key, entry.value];
        }),
      );
    }
    if (Array.isArray(source.volumes))
      service.volumes = source.volumes.map((raw) => {
        const volume = object(raw);
        if (typeof volume.hostPath !== "string" || typeof volume.containerPath !== "string")
          throw new CatalogError("invalid-runtipi-volume");
        return {
          type: "bind",
          source: volume.hostPath,
          target: volume.containerPath,
          read_only: volume.readOnly === true,
          ...(volume.bind ? { bind: volume.bind } : {}),
        };
      });
    const ports: unknown[] = [];
    if (source.isMain === true && Number.isInteger(source.internalPort))
      ports.push(`${Number(config.port) || 8080}:${String(source.internalPort)}`);
    for (const raw of Array.isArray(source.addPorts) ? source.addPorts : []) {
      const port = object(raw);
      const mapping = `${port.interface ? `${scalar(port.interface)}:` : ""}${String(port.hostPort)}:${String(port.containerPort)}`;
      if (port.tcp !== false) ports.push(`${mapping}/tcp`);
      if (port.udp === true) ports.push(`${mapping}/udp`);
    }
    if (ports.length) service.ports = ports;
    if (source.healthCheck) {
      const health = { ...object(source.healthCheck) };
      if (health.startPeriod !== undefined) {
        health.start_period = health.startPeriod;
        delete health.startPeriod;
      }
      if (health.startInterval !== undefined) {
        health.start_interval = health.startInterval;
        delete health.startInterval;
      }
      service.healthcheck = health;
    }
    services[name] = service;
  }
  return stringify({ services });
}

function portainerCompose(entry: Record<string, unknown>): string {
  if (entry.type !== 1) throw new CatalogError("unsupported-portainer-type");
  const volumes: Record<string, unknown> = {};
  const mounts = (Array.isArray(entry.volumes) ? entry.volumes : []).map((raw, index) => {
    const volume = object(raw);
    const bind = text(volume.bind);
    const name = `data${index}`;
    if (!bind) volumes[name] = {};
    return {
      type: bind ? "bind" : "volume",
      source: bind ?? name,
      target: volume.container,
      read_only: volume.readonly === true,
    };
  });
  const environment = Object.fromEntries(
    (Array.isArray(entry.env) ? entry.env : []).map((raw) => {
      const env = object(raw);
      const name = text(env.name);
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new CatalogError("invalid-portainer-environment");
      return [
        name,
        env.preset === true && env.default !== undefined
          ? scalar(env.default)
          : `\${${name}${env.default !== undefined ? `:-${scalar(env.default)}` : ""}}`,
      ];
    }),
  );
  const ports = strings(entry.ports).map((port) => (port.includes(":") ? port : `0:${port}`));
  const service = {
    image: entry.image,
    ...(entry.command ? { command: entry.command } : {}),
    ports,
    volumes: mounts,
    environment,
    restart: entry.restart_policy ?? "unless-stopped",
    privileged: entry.privileged === true,
    ...(entry.hostname ? { hostname: entry.hostname } : {}),
  };
  return stringify({
    services: { app: service },
    ...(Object.keys(volumes).length ? { volumes } : {}),
  });
}

export async function readCatalog(options: {
  catalogId: string;
  url: string;
  format: CatalogFormat;
  fetcher: CatalogFetcher;
  previous?: CatalogApp[];
}): Promise<CatalogSnapshot> {
  const { catalogId, url, fetcher } = options;
  const payload = await fetcher.get(url, 24 * 1024 * 1024);
  const ref = createHash("sha256").update(payload).digest("hex");
  const apps: CatalogApp[] = [];
  const skipped: CatalogSnapshot["skipped"] = [];
  const ids = new Set<string>();
  const add = (
    path: string,
    format: CatalogFormat,
    nativeId: string,
    compose: string,
    extra?: Record<string, unknown>,
  ) => {
    try {
      const id = slug(nativeId);
      if (ids.has(id)) throw new CatalogError("duplicate-native-id");
      const app = normalize(catalogId, ref, path, format, id, compose, {
        assetBase: new URL("./", url).href,
        ...extra,
      });
      ids.add(id);
      apps.push(app);
    } catch (error) {
      skipped.push({
        path,
        reason: error instanceof CatalogError ? error.reason : "invalid-manifest",
      });
    }
  };
  const isZip = payload.length >= 4 && payload.readUInt32LE(0) === 0x04034b50;
  let files: Map<string, string>;
  let json: Record<string, unknown> = {};
  if (isZip) files = readZip(payload);
  else {
    const content = payload.toString("utf8");
    if (/^\s*[[{]/.test(content)) {
      const parsed: unknown = JSON.parse(content);
      json = Array.isArray(parsed) ? { templates: parsed } : object(parsed);
    }
    files = new Map([["docker-compose.yml", content]]);
  }
  if (json.version === 2 && (json.store_id || Array.isArray(json.apps))) {
    if (!["auto", "casaos-v2"].includes(options.format)) throw new CatalogError("format-mismatch");
    let index = json;
    let base = url;
    if (!Array.isArray(index.apps)) {
      base = text(json.index_url)
        ? new URL(String(json.index_url), url).href
        : new URL("index.json", url).href;
      index = parseJson((await fetcher.get(base, 4 * 1024 * 1024)).toString("utf8"));
    }
    const entries = index.apps;
    if (!Array.isArray(entries) || entries.length > 2000) throw new CatalogError("invalid-index");
    base = new URL(text(index.base_url) ?? "./", base).href;
    let next = 0;
    // Bound concurrency while retaining a single byte and time budget.
    await Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (next < entries.length) {
          const entry = object(entries[next++]);
          const composeUrl = text(entry.compose_url);
          const metaUrl = text(entry.meta_url);
          if (!composeUrl || !metaUrl || !text(entry.id)) throw new CatalogError("invalid-index");
          const cacheKey = createHash("sha256")
            .update(JSON.stringify({ base, entry }))
            .digest("hex");
          const previous = options.previous?.find(
            (app) =>
              app.nativeId === slug(String(entry.id)) &&
              app.contentHash === entry.content_hash &&
              app.cacheKey === cacheKey &&
              app.source.path === composeUrl,
          );
          if (
            previous &&
            typeof entry.content_hash === "string" &&
            previous.variants &&
            previous.screenshots
          ) {
            const reused = structuredClone(previous);
            reused.source.ref = ref;
            apps.push(reused);
            ids.add(reused.nativeId);
            continue;
          }
          const compose = await fetcher.get(assetUrl(composeUrl, base) ?? "");
          const meta = parseJson(
            (await fetcher.get(assetUrl(metaUrl, base) ?? "")).toString("utf8"),
          );
          const variants: Record<string, string> = {};
          for (const arch of strings(entry.architectures).filter(
            (arch) => arch === "amd64" || arch === "arm64",
          )) {
            try {
              variants[arch] = cleanCompose(
                (
                  await fetcher.get(
                    assetUrl(composeUrl.replace(/\.ya?ml$/, `.${arch}.yml`), base) ?? "",
                  )
                ).toString("utf8"),
              );
            } catch (error) {
              if (!(error instanceof CatalogError && error.reason === "http-error")) throw error;
            }
          }
          add(composeUrl, "casaos-v2", String(entry.id), compose.toString("utf8"), {
            ...entry,
            ...meta,
            icon: assetUrl(
              String(entry.icon).endsWith(".svg")
                ? String(entry.icon).replace(/\.svg$/, ".png")
                : entry.icon,
              base,
            ),
            assetBase: base,
            cacheKey,
            composeVariants: variants,
          });
        }
      }),
    );
  } else if (Array.isArray(json.templates)) {
    if (!["auto", "portainer"].includes(options.format)) throw new CatalogError("format-mismatch");
    if (json.templates.length > 2000) throw new CatalogError("too-many-apps");
    for (const [index, raw] of json.templates.entries()) {
      const entry = object(raw);
      const path = `templates/${index}`;
      if (entry.type === "container" || entry.type === undefined) entry.type = 1;
      if (entry.type === "stack") entry.type = 3;
      try {
        if (entry.platform === "windows") throw new CatalogError("unsupported-portainer-platform");
        let compose: string;
        if (entry.type === 3) {
          const repo = object(entry.repository);
          const repository = new URL(String(repo.url));
          if (repository.hostname !== "github.com" || repository.username || repository.password)
            throw new CatalogError("unsupported-stack-repository");
          const segments = repository.pathname
            .replace(/\.git$/, "")
            .split("/")
            .filter(Boolean);
          if (segments.length !== 2) throw new CatalogError("unsupported-stack-repository");
          const stackfile = safePath(String(repo.stackfile));
          compose = (
            await fetcher.get(
              `https://raw.githubusercontent.com/${segments.join("/")}/${encodeURIComponent(text(repo.reference) ?? "HEAD")}/${stackfile}`,
            )
          ).toString("utf8");
        } else compose = portainerCompose(entry);
        add(
          path,
          "portainer",
          text(entry.name) ?? `${slug(text(entry.title) ?? "app")}-${index}`,
          compose,
          {
            ...entry,
            assetBase: url,
            icon: assetUrl(entry.logo, new URL("./", url).href),
            form_fields: (Array.isArray(entry.env) ? entry.env : []).map((raw) => {
              const env = object(raw);
              return { ...env, env_variable: env.name, type: "text", options: env.select };
            }),
          },
        );
      } catch (error) {
        if (
          error instanceof CatalogError &&
          ["http-error", "unsafe-address", "too-large", "timeout"].includes(error.reason)
        )
          throw error;
        skipped.push({
          path,
          reason: error instanceof CatalogError ? error.reason : "invalid-manifest",
        });
      }
    }
  } else if (
    Object.values(json).length &&
    Object.values(json).every(
      (entry) =>
        typeof object(entry).compose === "string" && typeof object(entry).slogan === "string",
    )
  ) {
    if (!["auto", "coolify"].includes(options.format)) throw new CatalogError("format-mismatch");
    if (Object.keys(json).length > 2000) throw new CatalogError("too-many-apps");
    for (const [id, raw] of Object.entries(json)) {
      const entry = object(raw);
      const encoded = String(entry.compose);
      if (encoded.length > 700_000) throw new CatalogError("too-large");
      add(id, "coolify", id, Buffer.from(encoded, "base64").toString("utf8"), {
        ...entry,
        title: id,
        assetBase: new URL("./", url).href,
      });
    }
  } else {
    if ([...files.keys()].some((path) => /(^|\/)umbrel-app\.ya?ml$/.test(path)))
      throw new CatalogError("unsupported-umbrel");
    const runtipi = [...files.keys()].filter((path) => /^apps\/[^/]+\/config\.json$/.test(path));
    const configs = runtipi.filter((path) => {
      try {
        return parseJson(files.get(path) ?? "").tipi_version !== undefined;
      } catch {
        return false;
      }
    });
    if (configs.length) {
      if (!["auto", "runtipi"].includes(options.format)) throw new CatalogError("format-mismatch");
      for (const path of configs) {
        try {
          const config = parseJson(files.get(path) ?? "");
          const dir = path.slice(0, path.lastIndexOf("/"));
          const native =
            files.get(`${dir}/docker-compose.yml`) ?? files.get(`${dir}/docker-compose.yaml`);
          let compose: string;
          const variants: Record<string, string> = {};
          if (native && object(parseCompose(native)["x-runtipi"]).schema_version) {
            const doc = parseCompose(native);
            const overrides = object(doc["x-runtipi"]).overrides;
            for (const raw of Object.values(object(doc.services))) {
              const svc = object(raw);
              const meta = object(svc["x-runtipi"]);
              if (meta.is_main === true && meta.internal_port)
                svc.ports = [
                  ...(Array.isArray(svc.ports) ? (svc.ports as unknown[]) : []),
                  `${Number(config.port) || 8080}:${scalar(meta.internal_port)}`,
                ];
            }
            compose = stringify(doc);
            for (const raw of Array.isArray(overrides) ? overrides : []) {
              const override = object(raw),
                arch = text(override.architecture);
              if (!arch || !["amd64", "arm64"].includes(arch)) continue;
              const variant = structuredClone(doc),
                services = object(variant.services);
              const replacements = Array.isArray(override.services)
                ? Object.fromEntries(
                    override.services.map((raw) => [String(object(raw).name), object(raw)]),
                  )
                : object(override.services);
              for (const [name, replacement] of Object.entries(replacements)) {
                if (!services[name]) throw new CatalogError("invalid-runtipi-override");
                const { name: _name, ...fields } = object(replacement);
                services[name] = { ...object(services[name]), ...fields };
              }
              variants[arch] = cleanCompose(stringify(variant));
            }
          } else {
            const dynamic = parseJson(files.get(`${dir}/docker-compose.json`) ?? "");
            compose = runtipiCompose(dynamic, config);
            for (const arch of ["amd64", "arm64"])
              variants[arch] = runtipiCompose(dynamic, config, arch);
          }
          add(path, "runtipi", dir.split("/").at(-1) ?? "app", compose, {
            ...config,
            composeVariants: variants,
            assetBase: new URL("./", url).href,
          });
        } catch (error) {
          skipped.push({
            path,
            reason: error instanceof CatalogError ? error.reason : "invalid-manifest",
          });
        }
      }
    } else {
      for (const [path, compose] of files) {
        if (
          !/\.ya?ml$/i.test(path) ||
          !/(^|\/)docker-compose\.ya?ml$|^templates\/compose\/[^/]+\.ya?ml$/.test(path)
        )
          continue;
        try {
          const doc = parseCompose(compose);
          const format: CatalogFormat = doc["x-casaos"]
            ? "casaos-source"
            : /^#\s*(documentation|slogan):/m.test(compose)
              ? "coolify"
              : "compose-dir";
          if (options.format !== "auto" && options.format !== format)
            throw new CatalogError("format-mismatch");
          const parts = path.split("/");
          const nativeId =
            text(object(doc["x-casaos"]).id) ??
            (parts.length > 1 ? parts.at(-2) : Object.keys(object(doc.services))[0]) ??
            "app";
          add(path, format, nativeId, compose);
        } catch (error) {
          skipped.push({
            path,
            reason: error instanceof CatalogError ? error.reason : "invalid-manifest",
          });
        }
      }
    }
  }
  if (!apps.length) throw new CatalogError("no-valid-apps");
  if (apps.length > 2000 || skipped.length > 2000) throw new CatalogError("too-many-apps");
  // The snapshot identity includes all fetched manifests, not just the root index.
  apps.sort((a, b) => a.id.localeCompare(b.id));
  const snapshot = createHash("sha256").update(ref).update(JSON.stringify(apps)).digest("hex");
  for (const app of apps) app.source.ref = snapshot;
  return { ref: snapshot, apps, skipped };
}
