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
  DockerError,
  type DockerApi,
  type HostPaths,
  type InternetProbeResult,
  type LogSource,
  type ServiceManager,
} from "@otuken/system";
import type { AgentMode } from "./config.ts";
import { POLICY_REASONS } from "./policy.ts";

export interface HandlerDependencies {
  mode: AgentMode;
  version: string;
  startedAt: number;
  services: ServiceManager;
  logs: LogSource;
  isProtected: (unit: string) => boolean;
  internet: () => Promise<InternetProbeResult>;
  docker: DockerApi;
  /** Containers that may only be started (agent.yaml `protectedContainers`). */
  isProtectedContainer: (name: string) => boolean;
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
  if (error instanceof DockerError) {
    switch (error.kind) {
      case "unavailable":
        throw new OperationError("unsupported", "Docker is not available on this host");
      case "permission-denied":
        throw new OperationError("unsupported", "The agent has no permission to use Docker");
      case "unsupported":
        throw new OperationError("unsupported", error.message);
      case "not-found":
        throw new OperationError("not_found", error.message);
      case "conflict":
        throw new OperationError("conflict", error.message);
      case "invalid":
        throw new OperationError("invalid_params", error.message);
      case "timeout":
        throw new OperationError("timeout", "Docker did not respond in time");
      case "too-large":
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
  let dockerLogStreams = 0;
  const docker = deps.docker;

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

    "docker.status": () => docker.status(),

    "docker.containers.list": async () => ({
      source: docker.source,
      containers: await docker.listContainers().catch(toOperationError),
    }),

    "docker.containers.get": ({ id }, { actor }) =>
      docker
        .inspectContainer(id, {
          // Commands can carry credentials as arguments, like process command lines.
          showCommand: actor.kind === "user" && roleHasPermission(actor.role, "docker:manage"),
        })
        .catch(toOperationError),

    "docker.containers.stats": async () => {
      const running = (await docker.listContainers().catch(toOperationError))
        .filter((container) => container.state === "running")
        .map((container) => container.id);
      return {
        source: docker.source,
        samples: await docker.stats(running).catch(toOperationError),
      };
    },

    "docker.containers.control": async ({ id, action }, { logger }) => {
      const container = (await docker.listContainers().catch(toOperationError)).find(
        (candidate) => candidate.id === id || candidate.id.startsWith(id),
      );
      if (!container) throw new OperationError("not_found", "Container not found");
      if (
        action !== "start" &&
        (container.protected || deps.isProtectedContainer(container.name))
      ) {
        throw new OperationError(
          "policy_denied",
          `${POLICY_REASONS.protectedContainer}: ${container.name} is protected; "${action}" is not allowed from Otuken`,
        );
      }
      await docker.controlContainer(container.id, action).catch(toOperationError);
      logger.info("Container action submitted", {
        container: container.name,
        action,
        source: docker.source,
      });
      return { accepted: true };
    },

    "docker.containers.logs": async function* ({ id, tail, follow, since }, { signal }) {
      if (dockerLogStreams >= maxFollows)
        throw new OperationError("busy", "Too many live log streams");
      dockerLogStreams += 1;
      try {
        for await (const line of docker.logs(id, { tail, follow, since }, signal)) yield line;
      } catch (error) {
        if (!signal.aborted) toOperationError(error);
      } finally {
        dockerLogStreams -= 1;
      }
    },

    "docker.images.list": async () => ({
      source: docker.source,
      images: await docker.listImages().catch(toOperationError),
    }),

    "docker.images.remove": async ({ id }, { logger }) => {
      await docker.removeImage(id).catch(toOperationError);
      logger.info("Image removed", { image: id });
      return { removed: true };
    },

    "docker.volumes.list": async () => ({
      source: docker.source,
      volumes: await docker.listVolumes().catch(toOperationError),
    }),

    "docker.volumes.remove": async ({ name }, { logger }) => {
      await docker.removeVolume(name).catch(toOperationError);
      logger.info("Volume removed", { volume: name });
      return { removed: true };
    },

    "docker.networks.list": async () => ({
      source: docker.source,
      networks: await docker.listNetworks().catch(toOperationError),
    }),

    "docker.networks.remove": async ({ id }, { logger }) => {
      await docker.removeNetwork(id).catch(toOperationError);
      logger.info("Network removed", { network: id });
      return { removed: true };
    },

    "docker.compose.projects": async () => ({
      source: docker.source,
      projects: await docker.listProjects().catch(toOperationError),
    }),

    "docker.compose.check": ({ project }) => docker.checkProject(project).catch(toOperationError),

    "docker.compose.run": async (
      { project, workingDir, configFiles, action },
      { signal, logger },
    ) => {
      // `up` can recreate services too; only `start` is safe for protected containers.
      if (action !== "start") {
        const protectedContainer = (await docker.listContainers().catch(toOperationError)).find(
          (container) =>
            container.project === project &&
            (container.protected || deps.isProtectedContainer(container.name)),
        );
        if (protectedContainer) {
          throw new OperationError(
            "policy_denied",
            `${POLICY_REASONS.protectedContainer}: ${protectedContainer.name} is protected; Compose "${action}" is not allowed from Otuken`,
          );
        }
      }
      const result = await docker
        .runCompose(project, workingDir, configFiles, action, signal)
        .catch(toOperationError);
      logger.info("Compose action finished", { project, action, ok: result.ok });
      return result;
    },

    "docker.events": async function* (_params, { signal }) {
      try {
        for await (const event of docker.events(signal)) yield event;
      } catch (error) {
        if (!signal.aborted) toOperationError(error);
      }
    },
  };
}
