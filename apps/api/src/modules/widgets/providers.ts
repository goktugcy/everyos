import { AgentClientError, type Actor } from "@everyos/agent-protocol";
import {
  CAPABILITY_REASONS,
  type LocalizedText,
  type Permission,
  type SystemAlert,
  type TopicUnavailableReason,
} from "@everyos/shared";
import type { AgentGateway } from "../../services.ts";
import type { DataProvider, ProviderResult } from "./data-hub.ts";

const SYSTEM_ACTOR: Actor = { kind: "system", component: "widgets" };

/** Maps agent failures to topic states; "<reason>: …" messages carry capability reasons. */
export function agentFailure(error: unknown): ProviderResult {
  if (error instanceof AgentClientError) {
    if (error.code === "AGENT_UNAVAILABLE") return { status: "error", code: "AGENT_UNAVAILABLE" };
    if (error.agentCode === "unsupported") {
      const prefix = /^([a-z-]+):/.exec(error.message)?.[1] ?? "";
      const reason = (CAPABILITY_REASONS as readonly string[]).includes(prefix)
        ? (prefix as TopicUnavailableReason)
        : "not-detected";
      return { status: "unavailable", reason };
    }
    return { status: "error", code: error.code };
  }
  return { status: "error", code: "INTERNAL_ERROR" };
}

type Agent = AgentGateway;

function provider(
  topic: string,
  permissions: readonly Permission[],
  intervalMs: number,
  collect: (agent: Agent, signal: AbortSignal) => Promise<unknown>,
  agent: Agent,
  view?: DataProvider["view"],
): DataProvider {
  return {
    topic,
    permissions,
    intervalMs,
    async collect(signal) {
      if (agent.state !== "connected") return { status: "error", code: "AGENT_UNAVAILABLE" };
      try {
        return { status: "ok", data: await collect(agent, signal) };
      } catch (error) {
        return agentFailure(error);
      }
    },
    ...(view ? { view } : {}),
  };
}

/** An alert with the permission needed to see it and structured details for notifications. */
export type TaggedAlert = SystemAlert & {
  permission: Permission;
  /** Identifies the same problem across checks (e.g. the unit or mount). */
  key: string;
  params: Record<string, string | number>;
};

/** Which sources answered; a failed check must not clear an earlier problem. */
export interface AlertSources {
  services: boolean;
  storage: boolean;
  docker: boolean;
  hardware: boolean;
  apt: boolean;
}

/** Current problems from real data, each tagged with the permission needed to see it. */
export async function collectAlerts(
  agent: Agent,
  signal: AbortSignal,
): Promise<{ source: "host" | "simulated"; alerts: TaggedAlert[]; sources: AlertSources }> {
  const call = <T>(promise: Promise<T>) => promise.catch(() => null);
  const [services, storage, containers, hardware, apt] = await Promise.all([
    call(agent.call("services.list", {}, SYSTEM_ACTOR, { signal })),
    call(agent.call("storage.usage", {}, SYSTEM_ACTOR, { signal })),
    call(agent.call("docker.containers.list", {}, SYSTEM_ACTOR, { signal })),
    call(agent.call("hardware.status", {}, SYSTEM_ACTOR, { signal })),
    call(agent.call("apt.updates", {}, SYSTEM_ACTOR, { signal })),
  ]);
  const alerts: TaggedAlert[] = [];
  for (const unit of (services?.units ?? []).filter((u) => u.active === "failed").slice(0, 10)) {
    alerts.push({
      kind: "service-failed",
      severity: "critical",
      subject: unit.name,
      permission: "services:read",
      key: unit.name,
      params: { unit: unit.name },
    });
  }
  for (const mount of storage?.mounts ?? []) {
    const total = mount.usedBytes + mount.availableBytes;
    const used = total > 0 ? mount.usedBytes / total : 0;
    if (used >= 0.9) {
      alerts.push({
        kind: "disk-full",
        severity: used >= 0.95 ? "critical" : "warning",
        subject: `${mount.mountpoint} ${Math.round(used * 100)}%`,
        permission: "system:read",
        key: mount.mountpoint,
        params: { mount: mount.mountpoint, percent: Math.round(used * 100) },
      });
    }
  }
  for (const container of (containers?.containers ?? []).slice(0, 2000)) {
    if (
      container.health === "unhealthy" ||
      container.state === "dead" ||
      container.state === "restarting"
    ) {
      alerts.push({
        kind: "container-unhealthy",
        severity: "warning",
        subject: container.name,
        permission: "docker:read",
        key: container.name,
        params: { container: container.name, state: container.state, health: container.health },
      });
    }
  }
  const flags = hardware?.throttling.flags;
  if (flags?.underVoltage)
    alerts.push({
      kind: "under-voltage",
      severity: "critical",
      subject: "now",
      permission: "system:read",
      key: "",
      params: { when: "now" },
    });
  else if (flags?.underVoltageOccurred)
    alerts.push({
      kind: "under-voltage",
      severity: "warning",
      subject: "since-boot",
      permission: "system:read",
      key: "",
      params: { when: "since-boot" },
    });
  if (flags && (flags.throttled || flags.frequencyCapped || flags.softTempLimit))
    alerts.push({
      kind: "throttling",
      severity: "warning",
      subject: "now",
      permission: "system:read",
      key: "",
      params: {},
    });
  for (const device of hardware?.nvme.devices ?? []) {
    if (device.healthy === false)
      alerts.push({
        kind: "nvme-unhealthy",
        severity: "critical",
        subject: device.device,
        permission: "system:read",
        key: device.device,
        params: { device: device.device },
      });
  }
  if (apt && apt.security > 0)
    alerts.push({
      kind: "security-updates",
      severity: "warning",
      subject: String(apt.security),
      permission: "system:read",
      key: "",
      params: { count: apt.security },
    });
  const simulated = [services, containers, apt].some((result) => result?.source === "simulated");
  return {
    source: simulated ? "simulated" : "host",
    alerts: alerts.slice(0, 50),
    sources: {
      services: services !== null,
      storage: storage !== null,
      docker: containers !== null,
      hardware: hardware !== null,
      apt: apt !== null,
    },
  };
}

/** Shared system data topics for widgets. */
export function systemProviders(
  agent: Agent,
  managedProjects: () => Array<{ id: string; name: LocalizedText; project: string }>,
): DataProvider[] {
  return [
    provider(
      "data.system",
      ["system:read"],
      5 * 60_000,
      async (a, signal) => {
        const info = await a.call("system.info", {}, SYSTEM_ACTOR, { signal });
        return {
          source: info.source,
          hostname: info.hostname,
          model: info.hardware.model,
          isRaspberryPi: info.hardware.isRaspberryPi,
          os: info.os.prettyName,
          kernel: info.kernel,
          arch: info.arch,
          memoryBytes: info.memory.totalBytes,
          cpu: info.cpu,
        };
      },
      agent,
    ),
    provider(
      "data.storage",
      ["system:read"],
      30_000,
      (a, signal) => a.call("storage.usage", {}, SYSTEM_ACTOR, { signal }),
      agent,
    ),
    provider(
      "data.network",
      ["system:read"],
      30_000,
      (a, signal) => a.call("network.status", {}, SYSTEM_ACTOR, { signal }),
      agent,
    ),
    provider(
      "data.tailscale",
      ["system:read"],
      30_000,
      (a, signal) => a.call("tailscale.status", {}, SYSTEM_ACTOR, { signal }),
      agent,
    ),
    provider(
      "data.hardware",
      ["system:read"],
      60_000,
      (a, signal) => a.call("hardware.status", {}, SYSTEM_ACTOR, { signal }),
      agent,
    ),
    provider(
      "data.processes",
      ["system:read"],
      5_000,
      async (a, signal) => {
        // One sampled list serves both orderings; command lines are never included.
        const list = await a.call("processes.list", { sort: "cpu", limit: 500 }, SYSTEM_ACTOR, {
          signal,
        });
        const brief = (p: (typeof list.processes)[number]) => ({
          pid: p.pid,
          name: p.name,
          user: p.user,
          cpuPercent: p.cpuPercent,
          memoryBytes: p.memoryBytes,
        });
        return {
          source: list.source,
          total: list.total,
          byCpu: list.processes.slice(0, 10).map(brief),
          byMemory: [...list.processes]
            .sort((x, y) => y.memoryBytes - x.memoryBytes)
            .slice(0, 10)
            .map(brief),
        };
      },
      agent,
    ),
    provider(
      "data.services",
      ["services:read"],
      30_000,
      async (a, signal) => {
        const { source, units } = await a.call("services.list", {}, SYSTEM_ACTOR, { signal });
        const loaded = units.filter((u) => u.load === "loaded");
        return {
          source,
          total: loaded.length,
          active: loaded.filter((u) => u.active === "active").length,
          failed: units
            .filter((u) => u.active === "failed")
            .slice(0, 20)
            .map((u) => ({ name: u.name, description: u.description })),
        };
      },
      agent,
    ),
    provider(
      "data.timers",
      ["services:read"],
      60_000,
      async (a, signal) => {
        const summary = await a.call("services.timers", {}, SYSTEM_ACTOR, { signal });
        return {
          source: summary.source,
          timers: [...summary.timers]
            .sort(
              (x, y) => (x.next ?? Number.MAX_SAFE_INTEGER) - (y.next ?? Number.MAX_SAFE_INTEGER),
            )
            .slice(0, 30),
        };
      },
      agent,
    ),
    provider(
      "data.sockets",
      ["system:read"],
      30_000,
      async (a, signal) => {
        const summary = await a.call("network.sockets", {}, SYSTEM_ACTOR, { signal });
        return { ...summary, listening: summary.listening.slice(0, 200) };
      },
      agent,
    ),
    provider(
      "data.apt",
      ["system:read"],
      30 * 60_000,
      async (a, signal) => {
        const updates = await a.call("apt.updates", {}, SYSTEM_ACTOR, { signal });
        return { ...updates, packages: updates.packages.slice(0, 20) };
      },
      agent,
    ),
    provider(
      "data.docker",
      ["docker:read"],
      10_000,
      async (a, signal) => {
        const { source, containers } = await a.call("docker.containers.list", {}, SYSTEM_ACTOR, {
          signal,
        });
        return {
          source,
          containers: containers.map((c) => ({
            id: c.id,
            name: c.name,
            image: c.image,
            state: c.state,
            health: c.health,
            status: c.status,
            project: c.project,
          })),
          apps: managedProjects(),
        };
      },
      agent,
      // Installed apps are listed only to users who may see apps.
      (data, permissions) =>
        permissions.has("apps:read") ? data : { ...(data as object), apps: [] },
    ),
    provider(
      "data.alerts",
      ["system:read"],
      30_000,
      (a, signal) => collectAlerts(a, signal),
      agent,
      (data, permissions) => {
        const { source, alerts } = data as { source: string; alerts: TaggedAlert[] };
        return {
          source,
          alerts: alerts
            .filter((alert) => permissions.has(alert.permission))
            .map(({ kind, severity, subject }) => ({ kind, severity, subject })),
        };
      },
    ),
  ];
}
