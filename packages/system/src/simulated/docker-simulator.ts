import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type {
  AppImage,
  ComposeAction,
  ContainerDetail,
  ContainerLogLine,
  ContainerRisk,
  ContainerState,
  ContainerSummary,
  DockerEvent,
  HealthState,
  ImageSummary,
  NetworkSummary,
  VolumeSummary,
} from "@everyos/shared";
import { DockerError, type DockerApi } from "../docker/client.ts";

/*
 * Development-only stand-in for the Docker Engine, used when the agent runs
 * in development mode without a Docker socket (or with
 * EVERYOS_AGENT_SIMULATE=1). Every response is marked `source: "simulated"`.
 * Nothing here touches the host.
 */

interface SimContainer {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  health: HealthState;
  project: string | null;
  service: string | null;
  ports: ContainerSummary["ports"];
  networks: string[];
  volumes: string[];
  risks: ContainerRisk[];
  envKeys: string[];
  startedAt: number | null;
  exitCode: number | null;
  memory: number;
}

interface SimProject {
  name: string;
  workingDir: string;
  configFiles: string[];
  managerHint: ContainerSummary["managerHint"];
}

const hex = (seed: string, length = 64) => {
  let hash = 2166136261;
  let out = "";
  while (out.length < length) {
    for (const char of seed + out.length)
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    out += hash.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
};

const port = (privatePort: number, publicPort: number | null, type: "tcp" | "udp" = "tcp") => ({
  privatePort,
  publicPort,
  type,
  ip: publicPort === null ? null : "0.0.0.0",
});

const PROJECTS: SimProject[] = [
  {
    name: "media",
    workingDir: "/srv/media",
    configFiles: ["/srv/media/compose.yaml"],
    managerHint: null,
  },
  {
    name: "cloud",
    workingDir: "/srv/cloud",
    configFiles: ["/srv/cloud/docker-compose.yml"],
    managerHint: null,
  },
  {
    name: "big-bear-pihole",
    workingDir: "/var/lib/casaos/apps/big-bear-pihole",
    configFiles: ["/var/lib/casaos/apps/big-bear-pihole/docker-compose.yml"],
    managerHint: "casaos",
  },
];

function initialContainers(now: number): SimContainer[] {
  const base = (name: string, rest: Partial<SimContainer>): SimContainer => ({
    id: hex(name),
    name,
    image: `${name}:latest`,
    state: "running",
    health: "none",
    project: null,
    service: null,
    ports: [],
    networks: ["bridge"],
    volumes: [],
    risks: [],
    envKeys: ["PATH", "TZ"],
    startedAt: now - 26 * 3_600_000,
    exitCode: 0,
    memory: 64 * 1024 ** 2,
    ...rest,
  });
  return [
    base("jellyfin", {
      image: "jellyfin/jellyfin:10.11",
      health: "healthy",
      project: "media",
      service: "jellyfin",
      ports: [port(8096, 8096)],
      networks: ["media_default"],
      volumes: ["media_config"],
      envKeys: ["PATH", "TZ", "JELLYFIN_PublishedServerUrl"],
      memory: 412 * 1024 ** 2,
    }),
    base("qbittorrent", {
      image: "lscr.io/linuxserver/qbittorrent:5.1",
      project: "media",
      service: "qbittorrent",
      ports: [port(8080, 8081), port(6881, 6881), port(6881, 6881, "udp")],
      networks: ["media_default"],
      envKeys: ["PATH", "TZ", "PUID", "PGID", "WEBUI_PORT"],
      memory: 180 * 1024 ** 2,
    }),
    base("nextcloud", {
      image: "nextcloud:31-apache",
      health: "healthy",
      project: "cloud",
      service: "app",
      ports: [port(80, 8443)],
      networks: ["cloud_default"],
      volumes: ["cloud_data"],
      envKeys: ["PATH", "POSTGRES_HOST", "POSTGRES_PASSWORD", "NEXTCLOUD_ADMIN_PASSWORD"],
      memory: 290 * 1024 ** 2,
    }),
    base("nextcloud-db", {
      image: "postgres:17-alpine",
      health: "healthy",
      project: "cloud",
      service: "db",
      networks: ["cloud_default"],
      volumes: ["cloud_db"],
      envKeys: ["PATH", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"],
      memory: 96 * 1024 ** 2,
    }),
    base("pihole", {
      image: "pihole/pihole:2025.10.0",
      health: "unhealthy",
      project: "big-bear-pihole",
      service: "pihole",
      ports: [port(53, 53), port(53, 53, "udp"), port(80, 8053)],
      networks: ["big-bear-pihole_default"],
      envKeys: ["PATH", "TZ", "FTLCONF_webserver_api_password"],
      risks: ["added-capabilities"],
    }),
    base("portainer", {
      image: "portainer/portainer-ce:2.33",
      ports: [port(9443, 9443)],
      risks: ["docker-socket"],
      memory: 48 * 1024 ** 2,
    }),
    base("homeassistant", {
      image: "ghcr.io/home-assistant/home-assistant:stable",
      networks: ["host"],
      risks: ["privileged", "host-network", "devices"],
      memory: 520 * 1024 ** 2,
    }),
    base("old-test", {
      image: "alpine:3.20",
      state: "exited",
      startedAt: null,
      exitCode: 1,
      memory: 0,
    }),
  ];
}

const LOG_LINES: Record<string, string[]> = {
  jellyfin: [
    "[INF] Main: Startup complete 0:00:04.1",
    "[INF] Scheduled task: Scan Media Library completed",
  ],
  qbittorrent: ["WebUI: Now listening on IP: *, port: 8080", "Torrent added: debian-13.iso"],
  nextcloud: ['127.0.0.1 - - "GET /status.php HTTP/1.1" 200 1203', "cron.php executed in 2.1 s"],
  "nextcloud-db": [
    "LOG:  checkpoint complete: wrote 42 buffers",
    "LOG:  database system is ready to accept connections",
  ],
  pihole: ["WARNING: DNS resolution is currently unavailable", "FTL started"],
  portainer: ["http server: listening on :9443"],
  homeassistant: ["Setup of domain mqtt took 1.2 seconds", "Home Assistant initialized in 12.4s"],
  "old-test": ["exit status 1"],
};

export function createDockerSimulator(
  options: { now?: () => number; isProtected?: (name: string) => boolean } = {},
): DockerApi {
  const now = options.now ?? Date.now;
  const isProtected = options.isProtected ?? (() => false);
  const started = now();
  let containers = initialContainers(started);
  const projects = new Map(PROJECTS.map((project) => [project.name, project]));
  const volumes = new Map<string, { project: string | null; size: number }>([
    ["media_config", { project: "media", size: 180 * 1024 ** 2 }],
    ["cloud_data", { project: "cloud", size: 12 * 1024 ** 3 }],
    ["cloud_db", { project: "cloud", size: 640 * 1024 ** 2 }],
    ["orphan_volume", { project: null, size: 24 * 1024 ** 2 }],
  ]);
  const extraImages = new Map<string, ImageSummary>([
    [
      hex("dangling"),
      {
        id: `sha256:${hex("dangling")}`,
        tags: [],
        createdAt: started - 40 * 86_400_000,
        sizeBytes: 88 * 1024 ** 2,
        dangling: true,
        usedBy: [],
      },
    ],
    [
      hex("redis"),
      {
        id: `sha256:${hex("redis")}`,
        tags: ["redis:7-alpine"],
        createdAt: started - 20 * 86_400_000,
        sizeBytes: 41 * 1024 ** 2,
        dangling: false,
        usedBy: [],
      },
    ],
  ]);
  const networks = new Map<string, Omit<NetworkSummary, "usedBy">>(
    [
      ["bridge", "bridge", null, true],
      ["host", "host", null, true],
      ["none", "null", null, true],
      ["media_default", "bridge", "media", false],
      ["cloud_default", "bridge", "cloud", false],
      ["big-bear-pihole_default", "bridge", "big-bear-pihole", false],
      ["unused_net", "bridge", null, false],
    ].map(([name, driver, project, builtIn]) => [
      hex(`net-${name as string}`),
      {
        id: hex(`net-${name as string}`),
        name: name as string,
        driver: driver as string,
        scope: "local",
        internal: false,
        subnets: builtIn ? [] : [`172.${18 + (name as string).length}.0.0/16`],
        project: project as string | null,
        builtIn: builtIn as boolean,
      },
    ]),
  );
  const listeners = new Set<(event: DockerEvent) => void>();
  const logBuffers = new Map<string, ContainerLogLine[]>();

  const emit = (type: DockerEvent["type"], action: string, id: string, name: string | null) => {
    const event: DockerEvent = { type, action, id, name, at: now() };
    for (const listener of listeners) listener(event);
  };
  const log = (container: SimContainer, line: string, stream: "stdout" | "stderr" = "stdout") => {
    const buffer = logBuffers.get(container.id) ?? [];
    buffer.push({ stream, ts: now(), line });
    if (buffer.length > 2_000) buffer.shift();
    logBuffers.set(container.id, buffer);
  };
  for (const container of containers) {
    const lines = LOG_LINES[container.name] ?? ["started"];
    const buffer: ContainerLogLine[] = [];
    for (let i = 0; i < 60; i++) {
      buffer.push({
        stream: container.name === "pihole" && i % 5 === 0 ? "stderr" : "stdout",
        ts: started - (60 - i) * 30_000,
        line: lines[i % lines.length]!,
      });
    }
    logBuffers.set(container.id, buffer);
  }

  const summary = (c: SimContainer): ContainerSummary => {
    const project = c.project ? projects.get(c.project) : undefined;
    return {
      id: c.id,
      name: c.name,
      image: c.image,
      imageId: `sha256:${hex(`img-${c.image}`)}`,
      state: c.state,
      status:
        c.state === "running"
          ? `Up 26 hours${c.health === "none" ? "" : ` (${c.health})`}`
          : `Exited (${c.exitCode ?? 0}) 3 days ago`,
      health: c.state === "running" ? c.health : "none",
      createdAt: started - 30 * 86_400_000,
      ports: c.state === "running" ? c.ports : [],
      project: c.project,
      service: c.service,
      networks: c.networks,
      managerHint: project?.managerHint ?? null,
      protected: isProtected(c.name),
    };
  };
  const find = (id: string) => {
    const container = containers.find((c) => c.id === id || c.id.startsWith(id));
    if (!container) throw new DockerError("not-found", "Container not found");
    return container;
  };
  const images = (): ImageSummary[] => {
    const byImage = new Map<string, ImageSummary>();
    for (const c of containers) {
      const id = `sha256:${hex(`img-${c.image}`)}`;
      const entry = byImage.get(id) ?? {
        id,
        tags: [c.image],
        createdAt: started - 30 * 86_400_000,
        sizeBytes: 150 * 1024 ** 2 + c.name.length * 9 * 1024 ** 2,
        dangling: false,
        usedBy: [],
      };
      entry.usedBy.push(c.name);
      byImage.set(id, entry);
    }
    return [...byImage.values(), ...extraImages.values()];
  };
  const setState = (c: SimContainer, state: ContainerState, action: string) => {
    c.state = state;
    c.startedAt = state === "running" ? now() : c.startedAt;
    log(c, `[everyos simulator] ${action}`);
    emit("container", action, c.id, c.name);
  };

  return {
    source: "simulated",
    resolveImages(input: string, platform: string) {
      const doc = parseYaml(input) as { services: Record<string, { image: string }> };
      const images: AppImage[] = Object.values(doc.services).map((service) => ({
        reference: service.image,
        digest: null,
        platform,
      }));
      return Promise.resolve({ compose: input, images });
    },

    status: () =>
      Promise.resolve({
        source: "simulated",
        status: { available: true },
        version: "29.0.0-simulated",
        apiVersion: "1.51",
        os: "linux",
        arch: "arm64",
        storageDriver: "overlay2",
        containers: {
          total: containers.length,
          running: containers.filter((c) => c.state === "running").length,
          paused: 0,
          stopped: containers.filter((c) => c.state !== "running").length,
        },
        images: images().length,
        compose: { available: true, version: "2.40.0-simulated" },
        gpu: { nvidia: false, amd: false },
      }),

    listContainers: () => Promise.resolve(containers.map(summary)),

    inspectContainer(id, inspectOptions) {
      const c = find(id);
      const detail: ContainerDetail = {
        ...summary(c),
        source: "simulated",
        command: inspectOptions.showCommand ? `/init --name ${c.name}` : null,
        entrypoint: null,
        workingDir: "/",
        user: null,
        envKeys: c.envKeys,
        labels: c.project
          ? {
              "com.docker.compose.project": c.project,
              "com.docker.compose.service": c.service ?? "",
            }
          : {},
        mounts: [
          ...c.volumes.map((name) => ({
            type: "volume",
            source: name,
            destination: "/data",
            readOnly: false,
          })),
          ...(c.risks.includes("docker-socket")
            ? [
                {
                  type: "bind",
                  source: "/var/run/docker.sock",
                  destination: "/var/run/docker.sock",
                  readOnly: false,
                },
              ]
            : []),
        ],
        networkDetails: c.networks.map((name, index) => ({
          name,
          ipAddress: name === "host" ? null : `172.20.0.${10 + index}`,
          gateway: name === "host" ? null : "172.20.0.1",
        })),
        restartPolicy: "unless-stopped",
        restartCount: 0,
        startedAt: c.startedAt,
        finishedAt: c.state === "running" ? null : started - 3 * 86_400_000,
        exitCode: c.state === "running" ? 0 : c.exitCode,
        oomKilled: false,
        pid: c.state === "running" ? 4000 + c.name.length : null,
        healthLog:
          c.health === "none"
            ? []
            : [
                {
                  at: now() - 30_000,
                  exitCode: c.health === "unhealthy" ? 1 : 0,
                  output: c.health === "unhealthy" ? "connection refused" : "ok",
                },
              ],
        limits: { memoryBytes: c.name === "nextcloud-db" ? 1024 ** 3 : null, cpus: null },
        risks: c.risks,
      };
      return Promise.resolve(detail);
    },

    stats(ids) {
      const at = now();
      const elapsed = Math.max(0, (at - started) / 1000);
      return Promise.resolve(
        containers
          .filter((c) => ids.includes(c.id) && c.state === "running")
          .map((c, index) => {
            const weight = 0.02 + (index % 4) * 0.03;
            return {
              id: c.id,
              at,
              cpuTotalNs: Math.round(
                (elapsed * weight + Math.sin(elapsed / 7 + index) * weight * 2 + 1) * 1e9,
              ),
              systemCpuNs: Math.round(elapsed * 4 * 1e9),
              onlineCpus: 4,
              memoryBytes: Math.round(c.memory * (1 + 0.05 * Math.sin(elapsed / 13 + index))),
              memoryLimitBytes: c.name === "nextcloud-db" ? 1024 ** 3 : null,
              netRxBytes: c.networks.includes("host")
                ? null
                : Math.round(elapsed * (2_000 + index * 900)),
              netTxBytes: c.networks.includes("host")
                ? null
                : Math.round(elapsed * (800 + index * 300)),
              blockReadBytes: Math.round(elapsed * 1_200 * (index + 1)),
              blockWriteBytes: Math.round(elapsed * 3_000 * (index + 1)),
              pids: 4 + index * 3,
            };
          }),
      );
    },

    controlContainer(id, action) {
      const c = find(id);
      if (action === "stop") setState(c, "exited", "stop");
      else setState(c, "running", action === "restart" ? "restart" : "start");
      return Promise.resolve();
    },

    async *logs(id, logOptions, signal) {
      const c = find(id);
      const buffer = logBuffers.get(c.id) ?? [];
      const backlog = buffer
        .filter((line) => logOptions.since === undefined || (line.ts ?? 0) >= logOptions.since)
        .slice(-logOptions.tail || buffer.length);
      for (const line of logOptions.tail === 0 ? [] : backlog) yield line;
      if (!logOptions.follow) return;
      let index = 0;
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (signal.aborted || c.state !== "running") continue;
        const lines = LOG_LINES[c.name] ?? ["tick"];
        const line: ContainerLogLine = {
          stream: "stdout",
          ts: now(),
          line: lines[index++ % lines.length]!,
        };
        log(c, line.line);
        yield line;
      }
    },

    listImages: () => Promise.resolve(images()),

    removeImage(id) {
      const image = images().find(
        (candidate) => candidate.id === id || candidate.id === `sha256:${id}`,
      );
      if (!image) return Promise.reject(new DockerError("not-found", "Image not found"));
      if (image.usedBy.length > 0)
        return Promise.reject(new DockerError("conflict", "Image is used by a container"));
      extraImages.delete(image.id.replace("sha256:", ""));
      emit("image", "delete", image.id, image.tags[0] ?? null);
      return Promise.resolve();
    },

    listVolumes: () =>
      Promise.resolve(
        [...volumes].map(([name, volume]): VolumeSummary => ({
          name,
          driver: "local",
          mountpoint: `/var/lib/docker/volumes/${name}/_data`,
          createdAt: started - 30 * 86_400_000,
          project: volume.project,
          sizeBytes: volume.size,
          usedBy: containers.filter((c) => c.volumes.includes(name)).map((c) => c.name),
        })),
      ),

    removeVolume(name) {
      if (!volumes.has(name))
        return Promise.reject(new DockerError("not-found", "Volume not found"));
      if (containers.some((c) => c.volumes.includes(name)))
        return Promise.reject(new DockerError("conflict", "Volume is used by a container"));
      volumes.delete(name);
      emit("volume", "destroy", name, name);
      return Promise.resolve();
    },

    listNetworks: () =>
      Promise.resolve(
        [...networks.values()].map((network) => ({
          ...network,
          usedBy: containers.filter((c) => c.networks.includes(network.name)).map((c) => c.name),
        })),
      ),

    removeNetwork(id) {
      const network = [...networks.values()].find((n) => n.id === id || n.id.startsWith(id));
      if (!network) return Promise.reject(new DockerError("not-found", "Network not found"));
      if (network.builtIn)
        return Promise.reject(new DockerError("invalid", "Built-in networks cannot be removed"));
      if (containers.some((c) => c.networks.includes(network.name)))
        return Promise.reject(new DockerError("conflict", "Network is used by a container"));
      networks.delete(network.id);
      emit("network", "destroy", network.id, network.name);
      return Promise.resolve();
    },

    // Simulated deployments never start containers, so they need no shared network.
    ensureAiNetwork: () => Promise.resolve(),

    listProjects: () =>
      Promise.resolve(
        [...projects.values()]
          .map((project) => {
            const members = containers.filter((c) => c.project === project.name);
            return {
              name: project.name,
              workingDir: project.workingDir,
              configFiles: project.configFiles,
              services: [...new Set(members.map((c) => c.service ?? c.name))],
              containers: {
                total: members.length,
                running: members.filter((c) => c.state === "running").length,
              },
              managerHint: project.managerHint,
            };
          })
          .filter((project) => project.containers.total > 0),
      ),

    checkProject(name) {
      const project = projects.get(name);
      if (!project || !containers.some((c) => c.project === name))
        return Promise.reject(new DockerError("not-found", "Compose project not found"));
      return Promise.resolve({
        project: name,
        workingDir: project.workingDir,
        files: project.configFiles.map((path) => ({ path, ok: true, reason: "ok" as const })),
      });
    },

    async runCompose(name, workingDir, files, action: ComposeAction, _signal, input) {
      let project = projects.get(name);
      if (/^otk-[a-f0-9]{32}$/.test(name) && (action === "up" || action === "update")) {
        const file = files[0];
        if (!file && input === undefined)
          throw new DockerError("invalid", "Missing simulated Compose file");
        const doc = parseYaml(input ?? (await readFile(file ?? "", "utf8"))) as {
          services: Record<
            string,
            {
              image: string;
              ports?: {
                target: number;
                published?: string;
                protocol: "tcp" | "udp";
                host_ip?: string;
              }[];
              environment?: Record<string, string>;
            }
          >;
        };
        project = { name, workingDir, configFiles: [...files], managerHint: null };
        projects.set(name, project);
        if (!containers.some((c) => c.project === name)) {
          for (const [service, entry] of Object.entries(doc.services)) {
            const allocated = new Set(
              containers.flatMap((c) => c.ports.map((p) => `${p.type}:${p.publicPort}`)),
            );
            const mappedPorts = (entry.ports ?? [])
              .filter((p) => typeof p === "object")
              .map((p) => {
                let published = Number(p.published) || 49152;
                while (!p.published && allocated.has(`${p.protocol}:${published}`)) published++;
                allocated.add(`${p.protocol}:${published}`);
                return { ...port(p.target, published, p.protocol), ip: p.host_ip ?? "0.0.0.0" };
              });
            const container: SimContainer = {
              id: hex(`${name}-${service}`),
              name: `${name}-${service}-1`,
              image: entry.image,
              state: "created",
              health: "none",
              project: name,
              service,
              ports: mappedPorts,
              networks: ["bridge"],
              volumes: [],
              risks: [],
              envKeys: Object.keys(entry.environment ?? {}),
              startedAt: null,
              exitCode: null,
              memory: 64 * 1024 ** 2,
            };
            containers.push(container);
            emit("container", "create", container.id, container.name);
          }
        }
      }
      if (!project) return Promise.reject(new DockerError("invalid", "Unknown project"));
      const members = () => containers.filter((c) => c.project === name);
      const lines: string[] = [];
      if (action === "down") {
        for (const c of members()) {
          lines.push(`Container ${c.name}  Removed`);
          emit("container", "destroy", c.id, c.name);
        }
        containers = containers.filter((c) => c.project !== name);
      } else if (action === "up" || action === "update") {
        if (action === "update") lines.push("Pulling images (simulated): up to date");
        if (members().length === 0) {
          for (const c of initialContainers(started).filter((c) => c.project === name)) {
            containers.push(c);
            setState(c, "running", "create");
            lines.push(`Container ${c.name}  Started`);
          }
        } else {
          for (const c of members()) {
            setState(c, "running", "start");
            lines.push(`Container ${c.name}  Running`);
          }
        }
      } else {
        for (const c of members()) {
          setState(c, action === "stop" ? "exited" : "running", action);
          lines.push(`Container ${c.name}  ${action === "stop" ? "Stopped" : "Started"}`);
        }
      }
      return Promise.resolve({ ok: true, output: lines.join("\n") });
    },

    postgresStats(container) {
      const found = containers.find((c) => c.name === container || c.id.startsWith(container));
      if (!found) return Promise.reject(new DockerError("not-found", "Container not found"));
      if (!found.image.startsWith("postgres"))
        return Promise.reject(new DockerError("invalid", "Not a PostgreSQL container"));
      if (found.state !== "running")
        return Promise.reject(new DockerError("conflict", "Container is not running"));
      return Promise.resolve({
        connections: 7,
        maxConnections: 100,
        databases: [
          { name: "nextcloud", sizeBytes: 412 * 1024 ** 2 },
          { name: "postgres", sizeBytes: 7 * 1024 ** 2 },
        ],
      });
    },

    async *events(signal) {
      const queue: DockerEvent[] = [];
      let wake: (() => void) | null = null;
      const listener = (event: DockerEvent) => {
        queue.push(event);
        wake?.();
      };
      listeners.add(listener);
      try {
        while (!signal.aborted) {
          while (queue.length > 0) yield queue.shift()!;
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          wake = null;
        }
      } finally {
        listeners.delete(listener);
      }
    },
  };
}
