import { existsSync, readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { isLogLevel, LOG_LEVELS, type LogLevel } from "@everyos/logger";
import { resolveEnvironment } from "@everyos/shared";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { COMMUNITY_APP_REGISTRY, OFFICIAL_APP_REGISTRY } from "./modules/desktop-apps/anchors.ts";

export const DEFAULT_PORT = 7470;

const CidrSchema = z.string().refine((value) => {
  const [address, prefix] = value.split("/");
  if (!address || isIP(address) === 0) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits >= 0 && bits <= (isIP(address) === 4 ? 32 : 128);
}, "must be an IP address or CIDR range");

const OriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/" && !url.search
  );
}, "must be an origin such as https://everyos.example.ts.net");

/** Shape of /etc/everyos/config.yaml. Every field is optional. */
const RegistryAnchorSchema = z.strictObject({
  url: z.url().max(2048),
  publicKey: z.string().min(40).max(512),
});

const ConfigFileSchema = z.strictObject({
  server: z
    .strictObject({
      host: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      /** Reverse proxies whose X-Forwarded-* headers are trusted. */
      trustedProxies: z.array(CidrSchema).optional(),
      /** Additional origins accepted by the CSRF origin check (e.g. a proxy hostname). */
      publicOrigins: z.array(OriginSchema).optional(),
      tls: z.strictObject({ certFile: z.string().min(1), keyFile: z.string().min(1) }).optional(),
    })
    .optional(),
  paths: z
    .strictObject({
      dataDir: z.string().min(1).optional(),
      webDir: z.string().min(1).optional(),
      secretKeyFile: z.string().min(1).optional(),
      agentSocket: z.string().min(1).optional(),
      agentKeyFile: z.string().min(1).optional(),
    })
    .optional(),
  security: z
    .strictObject({
      sessionIdleMinutes: z.number().int().min(5).max(43_200).optional(),
      sessionMaxAgeHours: z.number().int().min(1).max(8_760).optional(),
      cookieSecure: z.enum(["auto", "always", "never"]).optional(),
      hsts: z.boolean().optional(),
    })
    .optional(),
  logging: z
    .strictObject({
      level: z.enum(LOG_LEVELS).optional(),
      format: z.enum(["json", "pretty"]).optional(),
    })
    .optional(),
  /** File manager: nothing is exposed until roots are configured. */
  files: z
    .strictObject({
      roots: z
        .array(
          z.strictObject({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
            name: z.string().min(1).max(64),
            path: z.string().regex(/^\//, "must be an absolute path"),
            readOnly: z.boolean().optional(),
          }),
        )
        .max(32)
        .refine(
          (roots) => new Set(roots.map((r) => r.id)).size === roots.length,
          "duplicate root id",
        )
        .refine(
          (roots) => roots.every((r) => r.id !== "home" && !r.id.startsWith("sys-")),
          'root ids "home" and "sys-*" are reserved',
        )
        .optional(),
      maxUploadMiB: z.number().int().min(1).max(1_048_576).optional(),
      minFreeMiB: z.number().int().min(0).max(1_048_576).optional(),
      /** Private home folders for every user (default true), under <dataDir>/homes. */
      homes: z.boolean().optional(),
    })
    .optional(),
  /** Backup archives (docs/backups.md). */
  backups: z
    .strictObject({
      /** Where backups are stored, e.g. a separate disk. Default: <dataDir>/backups/archives. */
      dir: z.string().regex(/^\//, "must be an absolute path").optional(),
      /** Backups never leave less than this much free space on that disk. */
      minFreeMiB: z.number().int().min(0).max(1_048_576).optional(),
      maxUploadMiB: z.number().int().min(1).max(4_194_304).optional(),
    })
    .optional(),
  /**
   * Trust anchors of the built-in desktop app registries. Only this root-owned file can change
   * them (docs/app-sdk/architecture.md); the browser can add community and private registries.
   */
  desktopApps: z
    .strictObject({
      officialRegistry: RegistryAnchorSchema.optional(),
      communityRegistry: RegistryAnchorSchema.optional(),
    })
    .optional(),
});

export type RuntimeMode = "production" | "development";

export interface ApiConfig {
  mode: RuntimeMode;
  configFile: string | null;
  server: {
    host: string;
    port: number;
    trustedProxies: string[];
    publicOrigins: string[];
    tls: { certFile: string; keyFile: string } | null;
  };
  paths: {
    dataDir: string;
    databaseFile: string;
    backupDir: string;
    webDir: string | null;
    secretKeyFile: string;
    setupTokenFile: string;
    agentSocket: string;
    agentKeyFile: string;
  };
  security: {
    sessionIdleMs: number;
    sessionMaxAgeMs: number;
    cookieSecure: "auto" | "always" | "never";
    hsts: boolean;
  };
  logging: {
    level: LogLevel;
    format: "json" | "pretty";
  };
  files: {
    roots: Array<{ id: string; name: string; path: string; readOnly: boolean }>;
    maxUploadBytes: number;
    /** Uploads and copies leave at least this much free space. */
    minFreeBytes: number;
    /** Where users' private home folders live; null when disabled. */
    homesDir: string | null;
  };
  backups: {
    dir: string;
    minFreeBytes: number;
    maxUploadBytes: number;
  };
  desktopApps: {
    /** Installed packages and their unpacked files. */
    dir: string;
    officialRegistry: { url: string; publicKey: string } | null;
    communityRegistry: { url: string; publicKey: string } | null;
  };
  /**
   * Running as a systemd service in production: the API may exit after
   * staging a database restore and rely on the service manager to start it again.
   */
  supervised: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readConfigFile(path: string, required: boolean): z.infer<typeof ConfigFileSchema> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return {};
    throw new ConfigError(`Cannot read config ${path}: ${(error as Error).message}`);
  }
  const parsed = ConfigFileSchema.safeParse(parseYaml(text) ?? {});
  if (!parsed.success)
    throw new ConfigError(`Invalid config ${path}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ConfigError(`Invalid EVERYOS_PORT: ${value}`);
  return port;
}

/**
 * Resolves configuration from (highest precedence first) environment
 * variables, the YAML config file, and mode-specific defaults. Defaults bind
 * to loopback only; exposing EveryOS on the LAN is an explicit decision.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  env = resolveEnvironment(env);
  const mode: RuntimeMode = env.EVERYOS_ENV === "development" ? "development" : "production";
  const explicitConfig = env.EVERYOS_CONFIG;
  const configFile =
    explicitConfig ??
    (mode === "production"
      ? existsSync("/etc/everyos/config.yaml") || !existsSync("/etc/otuken/config.yaml")
        ? "/etc/everyos/config.yaml"
        : "/etc/otuken/config.yaml"
      : null);
  const file = configFile ? readConfigFile(configFile, Boolean(explicitConfig)) : {};

  const devRoot = env.EVERYOS_DEV_ROOT;
  if (mode === "development" && !devRoot) {
    throw new ConfigError("Development mode requires EVERYOS_DEV_ROOT (set by `pnpm dev`)");
  }
  const defaults =
    mode === "production"
      ? {
          dataDir:
            existsSync("/var/lib/everyos") || !existsSync("/var/lib/otuken/otuken.db")
              ? "/var/lib/everyos"
              : "/var/lib/otuken",
          webDir:
            existsSync("/usr/lib/everyos/web") || !existsSync("/usr/lib/otuken/web")
              ? "/usr/lib/everyos/web"
              : "/usr/lib/otuken/web",
          agentSocket:
            existsSync("/run/everyos/agent.sock") || !existsSync("/run/otuken/agent.sock")
              ? "/run/everyos/agent.sock"
              : "/run/otuken/agent.sock",
          agentKeyFile:
            existsSync("/etc/everyos/agent.key") || !existsSync("/etc/otuken/agent.key")
              ? "/etc/everyos/agent.key"
              : "/etc/otuken/agent.key",
        }
      : {
          dataDir: join(devRoot!, "data"),
          webDir: null,
          agentSocket: join(devRoot!, "run", "agent.sock"),
          agentKeyFile: join(devRoot!, "secrets", "agent.key"),
        };

  const dataDir = env.EVERYOS_DATA_DIR ?? file.paths?.dataDir ?? defaults.dataDir;
  const envLevel = env.EVERYOS_LOG_LEVEL;
  if (envLevel !== undefined && !isLogLevel(envLevel))
    throw new ConfigError(`Invalid EVERYOS_LOG_LEVEL: ${envLevel}`);

  const trustedProxies = file.server?.trustedProxies ?? [];
  const config: ApiConfig = {
    mode,
    configFile,
    server: {
      host: env.EVERYOS_HOST ?? file.server?.host ?? "127.0.0.1",
      port: parsePort(env.EVERYOS_PORT) ?? file.server?.port ?? DEFAULT_PORT,
      trustedProxies,
      publicOrigins: (file.server?.publicOrigins ?? []).map((origin) => new URL(origin).origin),
      tls: file.server?.tls ?? null,
    },
    paths: {
      dataDir,
      databaseFile:
        existsSync(join(dataDir, "everyos.db")) || !existsSync(join(dataDir, "otuken.db"))
          ? join(dataDir, "everyos.db")
          : join(dataDir, "otuken.db"),
      backupDir: join(dataDir, "backups"),
      webDir: env.EVERYOS_WEB_DIR ?? file.paths?.webDir ?? defaults.webDir,
      secretKeyFile:
        env.EVERYOS_SECRET_KEY_FILE ?? file.paths?.secretKeyFile ?? join(dataDir, "secret.key"),
      setupTokenFile: join(dataDir, "setup-token"),
      agentSocket: env.EVERYOS_AGENT_SOCKET ?? file.paths?.agentSocket ?? defaults.agentSocket,
      agentKeyFile: env.EVERYOS_AGENT_KEY_FILE ?? file.paths?.agentKeyFile ?? defaults.agentKeyFile,
    },
    security: {
      sessionIdleMs: (file.security?.sessionIdleMinutes ?? 720) * 60_000,
      sessionMaxAgeMs: (file.security?.sessionMaxAgeHours ?? 168) * 3_600_000,
      cookieSecure: file.security?.cookieSecure ?? "auto",
      hsts: file.security?.hsts ?? false,
    },
    logging: {
      level: envLevel ?? file.logging?.level ?? (mode === "development" ? "debug" : "info"),
      format: file.logging?.format ?? (mode === "development" ? "pretty" : "json"),
    },
    files: {
      // Production exposes nothing by default; development gets a sandbox directory.
      roots: (
        file.files?.roots ??
        (mode === "development"
          ? [{ id: "dev", name: "Development files", path: join(devRoot!, "files") }]
          : [])
      ).map((root) => ({ ...root, readOnly: root.readOnly ?? false })),
      maxUploadBytes: (file.files?.maxUploadMiB ?? 16 * 1024) * 1024 * 1024,
      minFreeBytes: (file.files?.minFreeMiB ?? 1024) * 1024 * 1024,
      homesDir: file.files?.homes === false ? null : join(dataDir, "homes"),
    },
    backups: {
      dir: env.EVERYOS_BACKUP_DIR ?? file.backups?.dir ?? join(dataDir, "backups", "archives"),
      minFreeBytes: (file.backups?.minFreeMiB ?? 1024) * 1024 * 1024,
      maxUploadBytes: (file.backups?.maxUploadMiB ?? 64 * 1024) * 1024 * 1024,
    },
    desktopApps: {
      dir: join(dataDir, "desktop-apps"),
      officialRegistry: file.desktopApps?.officialRegistry ?? OFFICIAL_APP_REGISTRY,
      communityRegistry: file.desktopApps?.communityRegistry ?? COMMUNITY_APP_REGISTRY,
    },
    supervised: mode === "production" && Boolean(env.INVOCATION_ID),
  };
  if (config.security.sessionIdleMs > config.security.sessionMaxAgeMs) {
    throw new ConfigError(
      "security.sessionIdleMinutes must not exceed security.sessionMaxAgeHours",
    );
  }
  return config;
}

/** Builds a matcher for the configured trusted proxy addresses. */
export function createProxyMatcher(entries: readonly string[]): (address: string) => boolean {
  if (entries.length === 0) return () => false;
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split("/") as [string, string | undefined];
    const type = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return (address) => {
    const type = isIP(address);
    if (type === 0) return false;
    return list.check(address, type === 6 ? "ipv6" : "ipv4");
  };
}

/** True when binding exposes the API beyond the local machine. */
export function isExposedBinding(host: string): boolean {
  return !["127.0.0.1", "::1", "localhost"].includes(host);
}
