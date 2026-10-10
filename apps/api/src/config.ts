import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { isLogLevel, LOG_LEVELS, type LogLevel } from "@otuken/logger";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

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
}, "must be an origin such as https://otuken.example.ts.net");

/** Shape of /etc/otuken/config.yaml. Every field is optional. */
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
    throw new ConfigError(`Invalid OTUKEN_PORT: ${value}`);
  return port;
}

/**
 * Resolves configuration from (highest precedence first) environment
 * variables, the YAML config file, and mode-specific defaults. Defaults bind
 * to loopback only; exposing Otuken on the LAN is an explicit decision.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const mode: RuntimeMode = env.OTUKEN_ENV === "development" ? "development" : "production";
  const explicitConfig = env.OTUKEN_CONFIG;
  const configFile = explicitConfig ?? (mode === "production" ? "/etc/otuken/config.yaml" : null);
  const file = configFile ? readConfigFile(configFile, Boolean(explicitConfig)) : {};

  const devRoot = env.OTUKEN_DEV_ROOT;
  if (mode === "development" && !devRoot) {
    throw new ConfigError("Development mode requires OTUKEN_DEV_ROOT (set by `pnpm dev`)");
  }
  const defaults =
    mode === "production"
      ? {
          dataDir: "/var/lib/otuken",
          webDir: "/usr/lib/otuken/web",
          agentSocket: "/run/otuken/agent.sock",
          agentKeyFile: "/etc/otuken/agent.key",
        }
      : {
          dataDir: join(devRoot!, "data"),
          webDir: null,
          agentSocket: join(devRoot!, "run", "agent.sock"),
          agentKeyFile: join(devRoot!, "secrets", "agent.key"),
        };

  const dataDir = env.OTUKEN_DATA_DIR ?? file.paths?.dataDir ?? defaults.dataDir;
  const envLevel = env.OTUKEN_LOG_LEVEL;
  if (envLevel !== undefined && !isLogLevel(envLevel))
    throw new ConfigError(`Invalid OTUKEN_LOG_LEVEL: ${envLevel}`);

  const trustedProxies = file.server?.trustedProxies ?? [];
  const config: ApiConfig = {
    mode,
    configFile,
    server: {
      host: env.OTUKEN_HOST ?? file.server?.host ?? "127.0.0.1",
      port: parsePort(env.OTUKEN_PORT) ?? file.server?.port ?? DEFAULT_PORT,
      trustedProxies,
      publicOrigins: (file.server?.publicOrigins ?? []).map((origin) => new URL(origin).origin),
      tls: file.server?.tls ?? null,
    },
    paths: {
      dataDir,
      databaseFile: join(dataDir, "otuken.db"),
      backupDir: join(dataDir, "backups"),
      webDir: env.OTUKEN_WEB_DIR ?? file.paths?.webDir ?? defaults.webDir,
      secretKeyFile:
        env.OTUKEN_SECRET_KEY_FILE ?? file.paths?.secretKeyFile ?? join(dataDir, "secret.key"),
      setupTokenFile: join(dataDir, "setup-token"),
      agentSocket: env.OTUKEN_AGENT_SOCKET ?? file.paths?.agentSocket ?? defaults.agentSocket,
      agentKeyFile: env.OTUKEN_AGENT_KEY_FILE ?? file.paths?.agentKeyFile ?? defaults.agentKeyFile,
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
