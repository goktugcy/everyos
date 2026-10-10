import { OperationError, type OperationHandlers } from "@otuken/agent-protocol";
import { roleHasPermission, type ProcessList, type SystemInfo } from "@otuken/shared";
import {
  collectHardware,
  collectMetrics,
  collectNetwork,
  collectProcesses,
  collectStorage,
  collectSystemInfo,
  getTailscaleStatus,
  LogSourceUnavailableError,
  REAL_HOST,
  ServiceError,
  type HostPaths,
  type InternetProbeResult,
  type LogSource,
  type ServiceManager,
} from "@otuken/system";
import type { AgentMode } from "./config.ts";

export interface HandlerDependencies {
  mode: AgentMode;
  version: string;
  startedAt: number;
  services: ServiceManager;
  logs: LogSource;
  isProtected: (unit: string) => boolean;
  internet: () => Promise<InternetProbeResult>;
  paths?: HostPaths;
  now?: () => number;
  collect?: () => Promise<SystemInfo>;
  tailscaleSockets?: readonly string[];
  /** Concurrent `journalctl --follow` processes across all connections. */
  maxLogFollows?: number;
}

/** Host information changes rarely; cache it briefly to bound filesystem reads. */
const SYSTEM_INFO_TTL_MS = 10_000;
const STORAGE_TTL_MS = 5_000;
/** smartctl wakes NVMe drives and is comparatively slow. */
const HARDWARE_TTL_MS = 30_000;
const PROCESSES_TTL_MS = 2_000;

/**
 * Caches an expensive collection for `ttlMs` and coalesces concurrent callers
 * into a single run. Failures are not cached.
 */
function cached<T>(ttlMs: number, now: () => number, load: () => Promise<T>): () => Promise<T> {
  let value: { data: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;
  return async () => {
    if (value && now() - value.at < ttlMs) return value.data;
    inflight ??= load()
      .then((data) => {
        value = { data, at: now() };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/** Translates collector errors into protocol errors with safe messages. */
function toOperationError(error: unknown): never {
  if (error instanceof OperationError) throw error;
  if (error instanceof ServiceError) {
    switch (error.kind) {
      case "unavailable":
        throw new OperationError("unsupported", "systemd is not available on this host");
      case "not-found":
        throw new OperationError("not_found", "Unit not found");
      case "invalid":
        throw new OperationError("invalid_params", "Invalid unit name");
      case "failed":
        throw new OperationError("failed", error.message);
    }
  }
  if (error instanceof LogSourceUnavailableError) {
    throw new OperationError("unsupported", "journald is not available on this host");
  }
  throw error;
}

export function createHandlers(deps: HandlerDependencies): OperationHandlers {
  const now = deps.now ?? Date.now;
  const paths = deps.paths ?? REAL_HOST;
  const maxFollows = deps.maxLogFollows ?? 8;
  let follows = 0;

  const systemInfo = cached(
    SYSTEM_INFO_TTL_MS,
    now,
    deps.collect ?? (() => collectSystemInfo({ paths })),
  );
  const storage = cached(STORAGE_TTL_MS, now, () => collectStorage({ paths }));
  const hardware = cached(HARDWARE_TTL_MS, now, async () =>
    collectHardware({ paths, isRaspberryPi: (await systemInfo()).hardware.isRaspberryPi }),
  );
  const processesBy = {
    cpu: cached(PROCESSES_TTL_MS, now, () => collectProcesses({ paths, sort: "cpu", limit: 500 })),
    memory: cached(PROCESSES_TTL_MS, now, () =>
      collectProcesses({ paths, sort: "memory", limit: 500 }),
    ),
  };

  return {
    "agent.ping": () => ({
      pong: true,
      agentVersion: deps.version,
      uptimeSeconds: Math.round((now() - deps.startedAt) / 1000),
      mode: deps.mode,
    }),

    "system.info": () => systemInfo(),

    "metrics.sample": () => collectMetrics({ paths, now }),

    "storage.usage": () => storage(),

    "hardware.status": () => hardware(),

    "network.status": () => collectNetwork({ paths, internet: deps.internet }),

    "tailscale.status": () => getTailscaleStatus(deps.tailscaleSockets),

    "processes.list": async ({ sort, limit }, { actor }) => {
      const list = await processesBy[sort]();
      // Command lines can contain credentials passed as arguments; only
      // actors allowed to manage the system see them.
      const showCommands = actor.kind === "user" && roleHasPermission(actor.role, "system:manage");
      const processes = list.processes.slice(0, limit);
      const result: ProcessList = {
        ...list,
        processes: showCommands ? processes : processes.map((p) => ({ ...p, command: p.name })),
      };
      return result;
    },

    "services.list": (_params, { signal }) =>
      deps.services.list(deps.isProtected, signal).catch(toOperationError),

    "services.get": ({ unit }, { signal }) =>
      deps.services.get(unit, deps.isProtected, signal).catch(toOperationError),

    "services.control": async ({ unit, action }, { signal, logger }) => {
      try {
        await deps.services.control(unit, action, signal);
      } catch (error) {
        toOperationError(error);
      }
      logger.info("Service action submitted", { unit, action, source: deps.services.source });
      return { accepted: true };
    },

    "logs.query": (query, { signal }) => deps.logs.query(query, signal).catch(toOperationError),

    "logs.follow": async function* (filter, { signal }) {
      if (follows >= maxFollows) throw new OperationError("busy", "Too many live log streams");
      follows += 1;
      try {
        for await (const entry of deps.logs.follow(filter, signal)) yield entry;
      } catch (error) {
        if (!signal.aborted) toOperationError(error);
      } finally {
        follows -= 1;
      }
    },
  };
}
