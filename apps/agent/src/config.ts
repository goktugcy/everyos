import { readFileSync } from "node:fs";
import { isLogLevel, LOG_LEVELS, type LogLevel } from "@otuken/logger";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Agent configuration. In production it is read from a root-owned file
 * (/etc/otuken/agent.yaml) that the unprivileged API cannot modify; the
 * agent never reads policy from locations writable by the otuken user.
 */
const AgentConfigFileSchema = z.strictObject({
  socketPath: z.string().min(1).optional(),
  agentKeyFile: z.string().min(1).optional(),
  /** Group allowed to connect to the socket (name or numeric gid). */
  socketGroup: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
  logLevel: z.enum(LOG_LEVELS).optional(),
});

export type AgentMode = "production" | "development";

export interface AgentConfig {
  mode: AgentMode;
  socketPath: string;
  agentKeyFile: string;
  socketGroup: string | number | null;
  logLevel: LogLevel;
  logFormat: "json" | "pretty";
  configFile: string | null;
}

const PRODUCTION_DEFAULTS = {
  configFile: "/etc/otuken/agent.yaml",
  socketPath: "/run/otuken/agent.sock",
  agentKeyFile: "/etc/otuken/agent.key",
  socketGroup: "otuken",
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readConfigFile(path: string, required: boolean): z.infer<typeof AgentConfigFileSchema> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return {};
    throw new ConfigError(`Cannot read agent config ${path}: ${(error as Error).message}`);
  }
  const parsed = AgentConfigFileSchema.safeParse(parseYaml(text) ?? {});
  if (!parsed.success) {
    throw new ConfigError(`Invalid agent config ${path}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const mode: AgentMode = env.OTUKEN_ENV === "development" ? "development" : "production";
  const explicitConfig = env.OTUKEN_AGENT_CONFIG;
  const configFile =
    explicitConfig ?? (mode === "production" ? PRODUCTION_DEFAULTS.configFile : null);
  const file = configFile ? readConfigFile(configFile, Boolean(explicitConfig)) : {};

  const devRoot = env.OTUKEN_DEV_ROOT;
  if (
    mode === "development" &&
    !devRoot &&
    (!env.OTUKEN_AGENT_SOCKET || !env.OTUKEN_AGENT_KEY_FILE)
  ) {
    throw new ConfigError("Development mode requires OTUKEN_DEV_ROOT (set by `pnpm dev`)");
  }
  const defaults =
    mode === "production"
      ? PRODUCTION_DEFAULTS
      : {
          socketPath: `${devRoot}/run/agent.sock`,
          agentKeyFile: `${devRoot}/secrets/agent.key`,
          socketGroup: null,
        };

  const envLevel = env.OTUKEN_LOG_LEVEL;
  if (envLevel !== undefined && !isLogLevel(envLevel))
    throw new ConfigError(`Invalid OTUKEN_LOG_LEVEL: ${envLevel}`);

  return {
    mode,
    socketPath: env.OTUKEN_AGENT_SOCKET ?? file.socketPath ?? defaults.socketPath,
    agentKeyFile: env.OTUKEN_AGENT_KEY_FILE ?? file.agentKeyFile ?? defaults.agentKeyFile,
    socketGroup: file.socketGroup ?? defaults.socketGroup,
    logLevel: envLevel ?? file.logLevel ?? (mode === "development" ? "debug" : "info"),
    logFormat: mode === "development" ? "pretty" : "json",
    configFile,
  };
}

/** Resolves a group name to its gid using /etc/group (Node has no getgrnam). */
export function resolveGroupId(group: string | number, groupFile = "/etc/group"): number {
  if (typeof group === "number") return group;
  if (/^\d+$/.test(group)) return Number(group);
  let text: string;
  try {
    text = readFileSync(groupFile, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read ${groupFile}: ${(error as Error).message}`);
  }
  for (const line of text.split("\n")) {
    const [name, , gid] = line.split(":");
    if (name === group && gid && /^\d+$/.test(gid)) return Number(gid);
  }
  throw new ConfigError(`Group "${group}" does not exist`);
}
