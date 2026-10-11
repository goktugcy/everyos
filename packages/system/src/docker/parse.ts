import {
  BUILT_IN_NETWORKS,
  CONTAINER_STATES,
  type ComposeProject,
  type ContainerDetail,
  type ContainerLogLine,
  type ContainerRisk,
  type ContainerState,
  type ContainerStatsSample,
  type ContainerSummary,
  type DockerEvent,
  type DockerManager,
  type HealthState,
  type ImageSummary,
  type NetworkSummary,
  type VolumeSummary,
} from "@everyos/shared";
import { sanitizeLogText } from "../linux/journal.ts";

/*
 * Pure parsers for Docker Engine API responses (tested against fixtures
 * recorded from Docker 29 on a Raspberry Pi 5). Every value is read
 * defensively: unknown shapes yield nulls, never exceptions.
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const cut = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

/** Docker uses "0001-01-01T00:00:00Z" for "never". */
export function parseDockerTime(value: unknown): number | null {
  const text = str(value);
  if (!text || text.startsWith("0001-")) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export const COMPOSE_LABELS = {
  project: "com.docker.compose.project",
  service: "com.docker.compose.service",
  workingDir: "com.docker.compose.project.working_dir",
  configFiles: "com.docker.compose.project.config_files",
  oneoff: "com.docker.compose.oneoff",
} as const;

/** Values of labels whose names suggest secrets are hidden. */
const SECRET_LABEL = /pass|secret|token|key|credential|auth/i;

export function redactLabels(labels: Json): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels).slice(0, 200)) {
    if (typeof value !== "string") continue;
    out[cut(key, 256)] = SECRET_LABEL.test(key) ? "••••••" : cut(value, 1024);
  }
  return out;
}

/** Another tool that appears to manage a Compose project (by its usual paths and labels). */
export function detectManager(labels: Json): DockerManager | null {
  const workingDir = str(labels[COMPOSE_LABELS.workingDir]) ?? "";
  if (labels["coolify.managed"] === "true") return "coolify";
  if (workingDir.startsWith("/var/lib/casaos/") || workingDir.startsWith("/DATA/AppData/casaos"))
    return "casaos";
  if (workingDir.includes("/runtipi/") || labels["runtipi.managed"] === "true") return "runtipi";
  if (workingDir.startsWith("/data/compose/")) return "portainer";
  return null;
}

function containerState(value: unknown): ContainerState {
  const state = str(value);
  return state && (CONTAINER_STATES as readonly string[]).includes(state)
    ? (state as ContainerState)
    : "exited";
}

/** Health from the structured field (API ≥ 1.52) or the status text ("Up 3 hours (healthy)"). */
export function containerHealth(raw: Json): HealthState {
  const structured = str(obj(raw.Health).Status);
  if (structured === "healthy" || structured === "unhealthy" || structured === "starting")
    return structured;
  const status = str(raw.Status) ?? "";
  if (status.includes("(healthy)")) return "healthy";
  if (status.includes("(unhealthy)")) return "unhealthy";
  if (status.includes("(health: starting)")) return "starting";
  return "none";
}

/** A container from `GET /containers/json`, with the raw fields other views need. */
export interface ListedContainer {
  summary: Omit<ContainerSummary, "protected">;
  labels: Json;
  volumeNames: string[];
}

export function parseContainerList(raw: unknown): ListedContainer[] {
  const out: ListedContainer[] = [];
  for (const item of arr(raw).slice(0, 2000)) {
    const c = obj(item);
    const id = str(c.Id);
    if (!id || !/^[a-f0-9]{64}$/.test(id)) continue;
    const labels = obj(c.Labels);
    const name = (str(arr(c.Names)[0]) ?? id.slice(0, 12)).replace(/^\//, "");
    const seen = new Set<string>();
    const ports: ContainerSummary["ports"] = [];
    for (const portItem of arr(c.Ports)) {
      const p = obj(portItem);
      const privatePort = num(p.PrivatePort);
      const type = str(p.Type);
      if (privatePort === null || (type !== "tcp" && type !== "udp" && type !== "sctp")) continue;
      const publicPort = num(p.PublicPort);
      // Docker lists IPv4 and IPv6 bindings separately; show each mapping once.
      const key = `${privatePort}/${type}/${publicPort ?? "-"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ports.push({ privatePort, publicPort, type, ip: str(p.IP) });
    }
    const project = str(labels[COMPOSE_LABELS.project]);
    out.push({
      summary: {
        id,
        name: cut(name, 256),
        image: cut(str(c.Image) ?? "", 512),
        imageId: cut(str(c.ImageID) ?? "", 128),
        state: containerState(c.State),
        status: cut(str(c.Status) ?? "", 256),
        health: containerHealth(c),
        createdAt: (num(c.Created) ?? 0) * 1000,
        ports: ports.slice(0, 256),
        project: project ? cut(project, 128) : null,
        service: project ? cut(str(labels[COMPOSE_LABELS.service]) ?? "", 128) || null : null,
        networks: Object.keys(obj(obj(c.NetworkSettings).Networks)).slice(0, 64),
        managerHint: project ? detectManager(labels) : null,
      },
      labels,
      volumeNames: arr(c.Mounts)
        .map(obj)
        .filter((m) => m.Type === "volume" && typeof m.Name === "string")
        .map((m) => m.Name as string),
    });
  }
  return out;
}

const DOCKER_SOCKETS = new Set(["/var/run/docker.sock", "/run/docker.sock"]);

export function containerRisks(inspect: Json): ContainerRisk[] {
  const host = obj(inspect.HostConfig);
  const securityOpt = arr(host.SecurityOpt).filter((v): v is string => typeof v === "string");
  const mounts = arr(inspect.Mounts).map(obj);
  const risks: ContainerRisk[] = [];
  if (host.Privileged === true) risks.push("privileged");
  if (mounts.some((m) => DOCKER_SOCKETS.has(str(m.Source) ?? ""))) risks.push("docker-socket");
  if (host.NetworkMode === "host") risks.push("host-network");
  if (host.PidMode === "host") risks.push("host-pid");
  if (host.IpcMode === "host") risks.push("host-ipc");
  if (arr(host.CapAdd).length > 0) risks.push("added-capabilities");
  if (arr(host.Devices).length > 0) risks.push("devices");
  if (securityOpt.some((o) => /^apparmor[=:]unconfined$/.test(o)))
    risks.push("apparmor-unconfined");
  if (securityOpt.some((o) => /^seccomp[=:]unconfined$/.test(o))) risks.push("seccomp-unconfined");
  if (mounts.some((m) => m.Type === "bind" && str(m.Source) === "/")) risks.push("host-root-mount");
  return risks;
}

function joinCommand(value: unknown): string | null {
  const parts = arr(value).filter((v): v is string => typeof v === "string");
  return parts.length > 0 ? cut(parts.join(" "), 2048) : null;
}

/**
 * `GET /containers/{id}/json` → detail view. Environment values never leave
 * this function (only variable names), labels that look like secrets are
 * masked and health-check output is sanitized and truncated.
 */
export function parseContainerInspect(
  raw: unknown,
  summary: ContainerSummary,
  options: { showCommand: boolean },
): Omit<ContainerDetail, "source"> {
  const inspect = obj(raw);
  const config = obj(inspect.Config);
  const host = obj(inspect.HostConfig);
  const state = obj(inspect.State);
  const health = obj(state.Health);
  const restart = obj(host.RestartPolicy);
  const memory = num(host.Memory);
  const nanoCpus = num(host.NanoCpus);
  return {
    ...summary,
    command: options.showCommand ? joinCommand(config.Cmd) : null,
    entrypoint: options.showCommand ? joinCommand(config.Entrypoint) : null,
    workingDir: str(config.WorkingDir) || null,
    user: str(config.User) || null,
    envKeys: arr(config.Env)
      .filter((v): v is string => typeof v === "string")
      .map((entry) => cut(entry.split("=")[0] ?? "", 256))
      .filter(Boolean)
      .slice(0, 512),
    labels: redactLabels(obj(config.Labels)),
    mounts: arr(inspect.Mounts)
      .map(obj)
      .slice(0, 256)
      .map((m) => ({
        type: cut(str(m.Type) ?? "unknown", 32),
        source: m.Type === "volume" ? (str(m.Name) ?? null) : (str(m.Source) ?? null),
        destination: cut(str(m.Destination) ?? "", 1024),
        readOnly: m.RW === false,
      })),
    networkDetails: Object.entries(obj(obj(inspect.NetworkSettings).Networks))
      .slice(0, 64)
      .map(([name, value]) => {
        const network = obj(value);
        return {
          name: cut(name, 256),
          ipAddress: str(network.IPAddress) || null,
          gateway: str(network.Gateway) || null,
        };
      }),
    restartPolicy: str(restart.Name) || null,
    restartCount: num(inspect.RestartCount) ?? 0,
    startedAt: parseDockerTime(state.StartedAt),
    finishedAt: parseDockerTime(state.FinishedAt),
    exitCode: num(state.ExitCode),
    oomKilled: state.OOMKilled === true,
    pid: num(state.Pid) || null,
    healthLog: arr(health.Log)
      .map(obj)
      .slice(-5)
      .map((entry) => ({
        at: parseDockerTime(entry.End) ?? parseDockerTime(entry.Start),
        exitCode: num(entry.ExitCode),
        output: cut(sanitizeLogText(str(entry.Output) ?? "").trim(), 1024),
      })),
    limits: {
      memoryBytes: memory && memory > 0 ? memory : null,
      cpus: nanoCpus && nanoCpus > 0 ? nanoCpus / 1e9 : null,
    },
    risks: containerRisks(inspect),
  };
}

/** `GET /containers/{id}/stats?stream=false&one-shot=true` → raw counters. */
export function parseContainerStats(raw: unknown, id: string, at: number): ContainerStatsSample {
  const stats = obj(raw);
  const cpu = obj(stats.cpu_stats);
  const memory = obj(stats.memory_stats);
  const memoryDetail = obj(memory.stats);
  const usage = num(memory.usage) ?? 0;
  // Same "working set" as `docker stats`: page cache that can be reclaimed is excluded.
  const inactiveFile =
    num(memoryDetail.inactive_file) ?? num(memoryDetail.total_inactive_file) ?? 0;
  const networks = Object.values(obj(stats.networks)).map(obj);
  const io = arr(obj(stats.blkio_stats).io_service_bytes_recursive).map(obj);
  const ioSum = (op: string) =>
    io.length === 0
      ? null
      : io
          .filter((entry) => str(entry.op)?.toLowerCase() === op)
          .reduce((total, entry) => total + (num(entry.value) ?? 0), 0);
  const limit = num(memory.limit);
  return {
    id,
    at,
    cpuTotalNs: num(obj(cpu.cpu_usage).total_usage) ?? 0,
    systemCpuNs: num(cpu.system_cpu_usage),
    onlineCpus: num(cpu.online_cpus),
    memoryBytes: Math.max(0, usage - inactiveFile),
    memoryLimitBytes: limit && limit > 0 ? limit : null,
    netRxBytes:
      networks.length > 0 ? networks.reduce((t, n) => t + (num(n.rx_bytes) ?? 0), 0) : null,
    netTxBytes:
      networks.length > 0 ? networks.reduce((t, n) => t + (num(n.tx_bytes) ?? 0), 0) : null,
    blockReadBytes: ioSum("read"),
    blockWriteBytes: ioSum("write"),
    pids: num(obj(stats.pids_stats).current),
  };
}

export function parseImages(raw: unknown, containers: readonly ListedContainer[]): ImageSummary[] {
  const usage = new Map<string, string[]>();
  for (const { summary } of containers) {
    const list = usage.get(summary.imageId) ?? [];
    list.push(summary.name);
    usage.set(summary.imageId, list);
  }
  return arr(raw)
    .map(obj)
    .slice(0, 5000)
    .flatMap((image) => {
      const id = str(image.Id);
      if (!id) return [];
      const tags = arr(image.RepoTags)
        .filter((t): t is string => typeof t === "string" && t !== "<none>:<none>")
        .slice(0, 256)
        .map((t) => cut(t, 512));
      return [
        {
          id: cut(id, 128),
          tags,
          createdAt: (num(image.Created) ?? 0) * 1000,
          sizeBytes: num(image.Size) ?? 0,
          dangling: tags.length === 0,
          usedBy: usage.get(id) ?? [],
        },
      ];
    });
}

export function parseVolumes(
  raw: unknown,
  sizes: ReadonlyMap<string, number>,
  containers: readonly ListedContainer[],
): VolumeSummary[] {
  return arr(obj(raw).Volumes)
    .map(obj)
    .slice(0, 5000)
    .flatMap((volume) => {
      const name = str(volume.Name);
      if (!name) return [];
      const labels = obj(volume.Labels);
      const size = sizes.get(name);
      return [
        {
          name: cut(name, 256),
          driver: cut(str(volume.Driver) ?? "local", 64),
          mountpoint: str(volume.Mountpoint),
          createdAt: parseDockerTime(volume.CreatedAt),
          project: str(labels[COMPOSE_LABELS.project]),
          sizeBytes: size !== undefined && size >= 0 ? size : null,
          usedBy: containers.filter((c) => c.volumeNames.includes(name)).map((c) => c.summary.name),
        },
      ];
    });
}

/** `GET /system/df?type=volume` → volume name → size in bytes (-1 means unknown). */
export function parseVolumeSizes(raw: unknown): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const volume of arr(obj(raw).Volumes).map(obj)) {
    const name = str(volume.Name);
    const size = num(obj(volume.UsageData).Size);
    if (name && size !== null) sizes.set(name, size);
  }
  return sizes;
}

export function parseNetworks(
  raw: unknown,
  containers: readonly ListedContainer[],
): NetworkSummary[] {
  return arr(raw)
    .map(obj)
    .slice(0, 1000)
    .flatMap((network) => {
      const id = str(network.Id);
      const name = str(network.Name);
      if (!id || !name) return [];
      const labels = obj(network.Labels);
      return [
        {
          id: cut(id, 128),
          name: cut(name, 256),
          driver: cut(str(network.Driver) ?? "", 64),
          scope: cut(str(network.Scope) ?? "", 32),
          internal: network.Internal === true,
          subnets: arr(obj(network.IPAM).Config)
            .map((c) => str(obj(c).Subnet))
            .filter((s): s is string => s !== null)
            .slice(0, 16),
          project: str(labels[COMPOSE_LABELS.project]),
          builtIn: (BUILT_IN_NETWORKS as readonly string[]).includes(name),
          // The network list leaves `Containers` empty; derive membership from containers.
          usedBy: containers
            .filter((c) => c.summary.networks.includes(name))
            .map((c) => c.summary.name),
        },
      ];
    });
}

/** Compose projects as seen through their containers' labels. */
export function composeProjects(containers: readonly ListedContainer[]): ComposeProject[] {
  const projects = new Map<string, ComposeProject>();
  for (const { summary, labels } of containers) {
    if (!summary.project || labels[COMPOSE_LABELS.oneoff] === "True") continue;
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(summary.project)) continue;
    let project = projects.get(summary.project);
    if (!project) {
      project = {
        name: summary.project,
        workingDir: str(labels[COMPOSE_LABELS.workingDir]),
        configFiles: (str(labels[COMPOSE_LABELS.configFiles]) ?? "")
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
          .slice(0, 16),
        services: [],
        containers: { total: 0, running: 0 },
        managerHint: summary.managerHint,
      };
      projects.set(summary.project, project);
    }
    project.containers.total += 1;
    if (summary.state === "running") project.containers.running += 1;
    if (summary.service && !project.services.includes(summary.service))
      project.services.push(summary.service);
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Lifecycle events EveryOS relays; healthcheck `exec_*` events (which carry commands) are dropped. */
export const RELAYED_EVENTS: Record<DockerEvent["type"], readonly string[]> = {
  container: [
    "create",
    "start",
    "stop",
    "die",
    "kill",
    "pause",
    "unpause",
    "restart",
    "destroy",
    "rename",
    "oom",
    "health_status",
    "update",
  ],
  image: ["pull", "delete", "tag", "untag", "import", "load"],
  volume: ["create", "destroy"],
  network: ["create", "destroy", "connect", "disconnect"],
};

export function parseDockerEvent(line: string): DockerEvent | null {
  let raw: Json;
  try {
    raw = obj(JSON.parse(line));
  } catch {
    return null;
  }
  const type = str(raw.Type);
  if (type !== "container" && type !== "image" && type !== "volume" && type !== "network")
    return null;
  // "health_status: healthy" → action "health_status", detail kept out (no free text relayed).
  const action = (str(raw.Action) ?? "").split(":")[0]!.trim();
  if (!RELAYED_EVENTS[type].includes(action)) return null;
  const actor = obj(raw.Actor);
  const timeNano = num(raw.timeNano);
  return {
    type,
    action,
    id: cut(str(actor.ID) ?? "", 256),
    name: str(obj(actor.Attributes).name),
    at: timeNano !== null ? Math.round(timeNano / 1e6) : (num(raw.time) ?? 0) * 1000,
  };
}

/**
 * Splits Docker's multiplexed log stream (non-TTY containers): each frame is
 * an 8-byte header [stream, 0, 0, 0, size (uint32 BE)] followed by payload.
 */
export class LogDemuxer {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Array<{ stream: "stdout" | "stderr"; data: Buffer }> {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: Array<{ stream: "stdout" | "stderr"; data: Buffer }> = [];
    while (this.#buffer.length >= 8) {
      const size = this.#buffer.readUInt32BE(4);
      if (size > 16 * 1024 * 1024) throw new Error("Docker log frame is too large");
      if (this.#buffer.length < 8 + size) break;
      frames.push({
        stream: this.#buffer[0] === 2 ? "stderr" : "stdout",
        data: this.#buffer.subarray(8, 8 + size),
      });
      this.#buffer = this.#buffer.subarray(8 + size);
    }
    return frames;
  }
}

/** One log line with Docker's RFC 3339 timestamp prefix (`timestamps=1`). */
export function parseLogLine(stream: "stdout" | "stderr", text: string): ContainerLogLine {
  const space = text.indexOf(" ");
  const ts = space > 0 ? Date.parse(text.slice(0, space)) : Number.NaN;
  const line = Number.isFinite(ts) ? text.slice(space + 1) : text;
  return { stream, ts: Number.isFinite(ts) ? ts : null, line: sanitizeLogText(line) };
}
