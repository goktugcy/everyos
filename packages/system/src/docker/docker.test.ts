import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComposeProjectSchema,
  ContainerDetailSchema,
  ContainerStatsSampleSchema,
  ContainerSummarySchema,
  ImageSummarySchema,
  NetworkSummarySchema,
  VolumeSummarySchema,
} from "@otuken/shared/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { createDockerSimulator } from "../simulated/docker-simulator.ts";
import { createDockerClient, DockerError } from "./client.ts";
import { checkComposeFile } from "./compose.ts";
import {
  composeProjects,
  containerHealth,
  LogDemuxer,
  parseContainerInspect,
  parseContainerList,
  parseContainerStats,
  parseDockerEvent,
  parseImages,
  parseLogLine,
  parseNetworks,
  parseVolumes,
  parseVolumeSizes,
} from "./parse.ts";

/* Shapes recorded from Docker 29.7 (API 1.55) on a Raspberry Pi 5; values are invented. */

const ID_DB = "a".repeat(64);
const ID_PROXY = "b".repeat(64);
const ID_SOLO = "c".repeat(64);

const LIST = [
  {
    Id: ID_DB,
    Names: ["/app_db"],
    Image: "postgres:17",
    ImageID: `sha256:${"1".repeat(64)}`,
    Command: "docker-entrypoint.sh postgres",
    Created: 1_760_000_000,
    Ports: [{ PrivatePort: 5432, Type: "tcp" }],
    Labels: {
      "com.docker.compose.project": "app",
      "com.docker.compose.service": "db",
      "com.docker.compose.project.working_dir": "/opt/app",
      "com.docker.compose.project.config_files": "/opt/app/docker-compose.yaml",
      "com.docker.compose.oneoff": "False",
    },
    State: "running",
    Status: "Up 18 hours (healthy)",
    HostConfig: { NetworkMode: "app_default" },
    Health: { Status: "healthy", FailingStreak: 0 },
    NetworkSettings: { Networks: { app_default: {} } },
    Mounts: [
      {
        Type: "volume",
        Name: "app_pgdata",
        Source: "/var/lib/docker/volumes/app_pgdata/_data",
        Destination: "/var/lib/postgresql/data",
        RW: true,
      },
    ],
  },
  {
    Id: ID_PROXY,
    Names: ["/app_proxy"],
    Image: "nginx:1.29",
    ImageID: `sha256:${"2".repeat(64)}`,
    Created: 1_760_000_100,
    Ports: [
      { IP: "0.0.0.0", PrivatePort: 443, PublicPort: 443, Type: "tcp" },
      { IP: "::", PrivatePort: 443, PublicPort: 443, Type: "tcp" },
    ],
    Labels: {
      "com.docker.compose.project": "app",
      "com.docker.compose.service": "proxy",
      "com.docker.compose.project.working_dir": "/opt/app",
      "com.docker.compose.project.config_files": "/opt/app/docker-compose.yaml",
    },
    State: "exited",
    Status: "Exited (0) 2 hours ago",
    NetworkSettings: { Networks: { app_default: {} } },
    Mounts: [],
  },
  {
    Id: ID_SOLO,
    Names: ["/model-runner"],
    Image: "docker/model-runner:latest",
    ImageID: `sha256:${"3".repeat(64)}`,
    Created: 1_760_000_200,
    Ports: [],
    Labels: { "org.opencontainers.image.title": "runner" },
    State: "running",
    Status: "Up 3 minutes (health: starting)",
    NetworkSettings: { Networks: { bridge: {} } },
    Mounts: [],
  },
  { Id: "not-a-real-id", Names: ["/ignored"] },
];

describe("docker parsers", () => {
  it("parses the container list and groups Compose projects", () => {
    const listed = parseContainerList(LIST);
    expect(listed).toHaveLength(3);
    for (const { summary } of listed) {
      expect(ContainerSummarySchema.safeParse({ ...summary, protected: false }).success).toBe(true);
    }
    const [db, proxy, solo] = listed.map((c) => c.summary);
    expect(db).toMatchObject({
      name: "app_db",
      state: "running",
      health: "healthy",
      project: "app",
      service: "db",
    });
    // IPv4 and IPv6 bindings of the same port are listed once.
    expect(proxy!.ports).toEqual([
      { privatePort: 443, publicPort: 443, type: "tcp", ip: "0.0.0.0" },
    ]);
    expect(solo).toMatchObject({ project: null, health: "starting", networks: ["bridge"] });
    expect(listed[0]!.volumeNames).toEqual(["app_pgdata"]);

    const projects = composeProjects(listed);
    expect(projects).toEqual([
      {
        name: "app",
        workingDir: "/opt/app",
        configFiles: ["/opt/app/docker-compose.yaml"],
        services: ["db", "proxy"],
        containers: { total: 2, running: 1 },
        managerHint: null,
      },
    ]);
    expect(ComposeProjectSchema.parse(projects[0])).toEqual(projects[0]);
  });

  it("recognises projects managed by other tools", () => {
    const [casa] = parseContainerList([
      {
        ...LIST[0],
        Labels: {
          "com.docker.compose.project": "big-bear-ollama",
          "com.docker.compose.project.working_dir": "/var/lib/casaos/apps/big-bear-ollama",
        },
      },
    ]);
    expect(casa!.summary.managerHint).toBe("casaos");
  });

  it("reads health from the status text on older APIs", () => {
    expect(containerHealth({ Status: "Up 1 hour (unhealthy)" })).toBe("unhealthy");
    expect(containerHealth({ Status: "Up 1 hour" })).toBe("none");
  });

  it("never exposes environment values and flags risky settings", () => {
    const [listed] = parseContainerList([LIST[0]]);
    const detail = parseContainerInspect(
      {
        Config: {
          Env: ["POSTGRES_PASSWORD=hunter2", "PATH=/usr/bin"],
          Cmd: ["postgres", "-c", "password=hunter2"],
          Labels: {
            "traefik.http.middlewares.auth.basicauth.users": "admin:$apr1$x",
            "app.tier": "db",
          },
        },
        HostConfig: {
          Privileged: true,
          NetworkMode: "host",
          CapAdd: ["NET_ADMIN"],
          SecurityOpt: ["apparmor=unconfined"],
          RestartPolicy: { Name: "unless-stopped" },
          Memory: 0,
          NanoCpus: 1_500_000_000,
        },
        State: {
          StartedAt: "2026-10-10T00:36:56.123Z",
          FinishedAt: "0001-01-01T00:00:00Z",
          ExitCode: 0,
          Pid: 4242,
          Health: {
            Status: "healthy",
            Log: [
              {
                Start: "2026-10-10T10:00:00Z",
                End: "2026-10-10T10:00:01Z",
                ExitCode: 0,
                Output: "\u001b[32maccepting\u001b[0m connections\n",
              },
            ],
          },
        },
        Mounts: [
          {
            Type: "bind",
            Source: "/var/run/docker.sock",
            Destination: "/var/run/docker.sock",
            RW: false,
          },
          {
            Type: "volume",
            Name: "app_pgdata",
            Source: "/var/lib/docker/volumes/app_pgdata/_data",
            Destination: "/data",
            RW: true,
          },
        ],
        NetworkSettings: {
          Networks: { app_default: { IPAddress: "172.18.0.2", Gateway: "172.18.0.1" } },
        },
      },
      { ...listed!.summary, protected: false },
      { showCommand: false },
    );
    expect(ContainerDetailSchema.safeParse({ ...detail, source: "host" }).success).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("hunter2");
    expect(detail.envKeys).toEqual(["POSTGRES_PASSWORD", "PATH"]);
    expect(detail.command).toBeNull();
    expect(detail.labels).toEqual({
      "traefik.http.middlewares.auth.basicauth.users": "••••••",
      "app.tier": "db",
    });
    expect(detail.risks).toEqual([
      "privileged",
      "docker-socket",
      "host-network",
      "added-capabilities",
      "apparmor-unconfined",
    ]);
    expect(detail).toMatchObject({
      startedAt: Date.parse("2026-10-10T00:36:56.123Z"),
      finishedAt: null,
      pid: 4242,
      limits: { memoryBytes: null, cpus: 1.5 },
      restartPolicy: "unless-stopped",
    });
    expect(detail.healthLog[0]!.output).toBe("accepting connections");
    expect(detail.mounts[1]).toEqual({
      type: "volume",
      source: "app_pgdata",
      destination: "/data",
      readOnly: false,
    });
  });

  it("parses one-shot stats into raw counters (cgroup v2 working set)", () => {
    const sample = parseContainerStats(
      {
        cpu_stats: {
          cpu_usage: { total_usage: 924_286_891_000 },
          system_cpu_usage: 256_960_840_000_000,
          online_cpus: 4,
        },
        precpu_stats: { cpu_usage: { total_usage: 0 } },
        memory_stats: {
          usage: 1_103_822_848,
          limit: 8_249_311_232,
          stats: { inactive_file: 895_434_752 },
        },
        networks: { eth0: { rx_bytes: 100, tx_bytes: 50 }, eth1: { rx_bytes: 1, tx_bytes: 2 } },
        blkio_stats: {
          io_service_bytes_recursive: [
            { op: "read", value: 10 },
            { op: "write", value: 20 },
            { op: "Read", value: 5 },
          ],
        },
        pids_stats: { current: 17 },
      },
      ID_DB,
      7,
    );
    expect(ContainerStatsSampleSchema.parse(sample)).toEqual(sample);
    expect(sample).toMatchObject({
      memoryBytes: 1_103_822_848 - 895_434_752,
      netRxBytes: 101,
      netTxBytes: 52,
      blockReadBytes: 15,
      blockWriteBytes: 20,
      pids: 17,
      onlineCpus: 4,
    });
    // Host-network containers have no per-container network counters.
    expect(
      parseContainerStats({ cpu_stats: {}, memory_stats: {} }, ID_DB, 0).netRxBytes,
    ).toBeNull();
  });

  it("derives image, volume and network usage from containers", () => {
    const listed = parseContainerList(LIST);
    const images = parseImages(
      [
        { Id: `sha256:${"1".repeat(64)}`, RepoTags: ["postgres:17"], Created: 1, Size: 100 },
        { Id: `sha256:${"9".repeat(64)}`, RepoTags: ["<none>:<none>"], Created: 2, Size: 5 },
      ],
      listed,
    );
    expect(images.map((i) => [i.tags, i.dangling, i.usedBy])).toEqual([
      [["postgres:17"], false, ["app_db"]],
      [[], true, []],
    ]);
    for (const image of images) expect(ImageSummarySchema.safeParse(image).success).toBe(true);

    const volumes = parseVolumes(
      {
        Volumes: [
          {
            Name: "app_pgdata",
            Driver: "local",
            Labels: { "com.docker.compose.project": "app" },
            CreatedAt: "2026-01-01T00:00:00Z",
          },
          { Name: "orphan", Driver: "local", Labels: null },
        ],
      },
      parseVolumeSizes({
        Volumes: [
          { Name: "app_pgdata", UsageData: { Size: 4096, RefCount: 1 } },
          { Name: "orphan", UsageData: { Size: -1 } },
        ],
      }),
      listed,
    );
    expect(volumes.map((v) => [v.name, v.sizeBytes, v.usedBy, v.project])).toEqual([
      ["app_pgdata", 4096, ["app_db"], "app"],
      ["orphan", null, [], null],
    ]);
    for (const volume of volumes) expect(VolumeSummarySchema.safeParse(volume).success).toBe(true);

    const networks = parseNetworks(
      [
        {
          Name: "bridge",
          Id: "d".repeat(64),
          Driver: "bridge",
          Scope: "local",
          IPAM: { Config: [{ Subnet: "172.17.0.0/16" }] },
          Containers: {},
        },
        {
          Name: "app_default",
          Id: "e".repeat(64),
          Driver: "bridge",
          Scope: "local",
          Labels: { "com.docker.compose.project": "app" },
          Containers: {},
        },
      ],
      listed,
    );
    expect(networks.map((n) => [n.name, n.builtIn, n.usedBy])).toEqual([
      ["bridge", true, ["model-runner"]],
      ["app_default", false, ["app_db", "app_proxy"]],
    ]);
    for (const network of networks)
      expect(NetworkSummarySchema.safeParse(network).success).toBe(true);
  });

  it("relays lifecycle events and drops healthcheck exec events", () => {
    const event = (Type: string, Action: string) =>
      JSON.stringify({
        Type,
        Action,
        Actor: { ID: ID_DB, Attributes: { name: "app_db" } },
        time: 1_760_000_000,
        timeNano: 1_760_000_000_123 * 1e6,
      });
    expect(parseDockerEvent(event("container", "start"))).toEqual({
      type: "container",
      action: "start",
      id: ID_DB,
      name: "app_db",
      at: 1_760_000_000_123,
    });
    expect(parseDockerEvent(event("container", "health_status: unhealthy"))?.action).toBe(
      "health_status",
    );
    expect(
      parseDockerEvent(event("container", "exec_create: /bin/sh -c pg_isready --password=x")),
    ).toBeNull();
    expect(parseDockerEvent(event("plugin", "enable"))).toBeNull();
    expect(parseDockerEvent("{not json")).toBeNull();
  });

  it("demultiplexes log frames split across chunks", () => {
    const frame = (stream: number, text: string) => {
      const payload = Buffer.from(text);
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    const data = Buffer.concat([
      frame(1, "2026-10-10T10:00:00.5Z hello\n"),
      frame(2, "2026-10-10T10:00:01Z oops\n"),
    ]);
    const demux = new LogDemuxer();
    const frames = [...demux.push(data.subarray(0, 11)), ...demux.push(data.subarray(11))];
    expect(frames.map((f) => [f.stream, f.data.toString()])).toEqual([
      ["stdout", "2026-10-10T10:00:00.5Z hello\n"],
      ["stderr", "2026-10-10T10:00:01Z oops\n"],
    ]);
    expect(parseLogLine("stderr", "2026-10-10T10:00:01Z \u001b[31moops\u001b[0m")).toEqual({
      stream: "stderr",
      ts: Date.parse("2026-10-10T10:00:01Z"),
      line: "oops",
    });
  });

  it("rejects an oversized log frame before buffering its payload", () => {
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(16 * 1024 * 1024 + 1, 4);
    expect(() => new LogDemuxer().push(header)).toThrow("Docker log frame is too large");
  });
});

describe("compose file checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "otk-compose-"));
  writeFileSync(join(dir, "compose.yaml"), "services:\n  web:\n    image: nginx\n");
  writeFileSync(join(dir, "netplan.yaml"), "network:\n  version: 2\n");
  writeFileSync(join(dir, "secret.txt"), "root:x:0:0\n");
  symlinkSync(join(dir, "secret.txt"), join(dir, "sneaky.yml"));
  mkdirSync(join(dir, "dir.yml"));

  it("accepts real Compose files only", async () => {
    expect(await checkComposeFile(join(dir, "compose.yaml"))).toMatchObject({
      ok: true,
      reason: "ok",
    });
    expect((await checkComposeFile(join(dir, "netplan.yaml"))).reason).toBe("not-compose");
    expect((await checkComposeFile("/etc/shadow")).reason).toBe("invalid-path");
    expect((await checkComposeFile(`${dir}/../compose.yaml`)).reason).toBe("invalid-path");
    expect((await checkComposeFile("relative/compose.yaml")).reason).toBe("invalid-path");
    // A .yml symlink to a non-YAML file is rejected by its resolved path.
    expect((await checkComposeFile(join(dir, "sneaky.yml"))).reason).toBe("invalid-path");
    expect((await checkComposeFile(join(dir, "dir.yml"))).reason).toBe("not-regular");
    expect((await checkComposeFile(join(dir, "missing.yml"))).reason).toBe("missing");
  });
});

/* ------------------------- client over a fake Docker ------------------------- */

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length > 0) await new Promise((resolve) => servers.pop()!.close(resolve));
});

async function fakeDocker(apiVersion = "1.55") {
  const socketPath = join(mkdtempSync(join(tmpdir(), "otk-docker-")), "docker.sock");
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const url = new URL(req.url ?? "/", "http://docker");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Api-Version": apiVersion });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (url.pathname === "/_ping") return send(200, "OK");
    const path = url.pathname.replace(/^\/v[\d.]+/, "");
    if (path === "/containers/json") {
      const filters = url.searchParams.get("filters");
      const ids = filters ? (JSON.parse(filters) as { id: string[] }).id : null;
      return send(200, ids ? LIST.filter((c) => ids.includes(c.Id)) : LIST);
    }
    if (path === `/containers/${ID_DB}/json`)
      return send(200, { Config: { Tty: false, Env: ["A=1"] }, State: {}, HostConfig: {} });
    if (path === `/containers/${ID_PROXY}/start`) return send(304, undefined);
    if (path === `/containers/${ID_DB}/stop`)
      return send(409, { message: "container is restarting" });
    if (path === `/containers/${ID_DB}/logs`) {
      res.writeHead(200, { "Content-Type": "application/vnd.docker.multiplexed-stream" });
      if (url.searchParams.get("tail") === "2") {
        const frame = (stream: number, payload: Buffer) => {
          const header = Buffer.alloc(8);
          header[0] = stream;
          header.writeUInt32BE(payload.length, 4);
          return Buffer.concat([header, payload]);
        };
        const text = Buffer.from("çalışıyor\n");
        res.end(
          Buffer.concat([
            frame(1, Buffer.concat([Buffer.from("2026-10-10T10:00:00Z "), text.subarray(0, 1)])),
            frame(2, Buffer.from("2026-10-10T10:00:01Z hata\n")),
            frame(1, text.subarray(1)),
          ]),
        );
        return;
      }
      const payload = Buffer.from("2026-10-10T10:00:00Z ready\n");
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(payload.length, 4);
      res.end(Buffer.concat([header, payload]));
      return;
    }
    if (path === "/events") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write(
        `${JSON.stringify({ Type: "container", Action: "exec_start: sh", Actor: { ID: ID_DB, Attributes: {} }, time: 1 })}\n`,
      );
      res.write(
        `${JSON.stringify({ Type: "container", Action: "die", Actor: { ID: ID_DB, Attributes: { name: "app_db" } }, time: 2 })}\n`,
      );
      return; // Stays open like the real endpoint.
    }
    return send(404, { message: "page not found" });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  servers.push(server);
  return { socketPath, requests };
}

describe("docker client", () => {
  it("preserves UTF-8 characters split across interleaved stdout/stderr frames", async () => {
    const { socketPath } = await fakeDocker();
    const client = createDockerClient({ socketPaths: [socketPath] });
    const lines = [];
    for await (const line of client.logs(
      ID_DB,
      { tail: 2, follow: false },
      new AbortController().signal,
    ))
      lines.push(line);
    expect(lines).toEqual([
      { stream: "stderr", ts: Date.parse("2026-10-10T10:00:01Z"), line: "hata" },
      { stream: "stdout", ts: Date.parse("2026-10-10T10:00:00Z"), line: "çalışıyor" },
    ]);
  });
  it("negotiates the API version and lists containers through the socket", async () => {
    const { socketPath, requests } = await fakeDocker("1.55");
    const client = createDockerClient({
      socketPaths: [socketPath],
      isProtected: (name) => name === "app_db",
    });
    const containers = await client.listContainers();
    expect(containers.map((c) => [c.name, c.protected])).toEqual([
      ["app_db", true],
      ["app_proxy", false],
      ["model-runner", false],
    ]);
    // Newer servers are addressed at the version Otuken was written for.
    expect(requests.at(-1)).toMatch(/^GET \/v1\.51\/containers\/json\?all=1/);
  });

  it("uses older servers at their own version and rejects very old ones", async () => {
    const old = await fakeDocker("1.43");
    await createDockerClient({ socketPaths: [old.socketPath] }).listContainers();
    expect(old.requests.at(-1)).toMatch(/^GET \/v1\.43\//);
    const ancient = await fakeDocker("1.40");
    await expect(
      createDockerClient({ socketPaths: [ancient.socketPath] }).listContainers(),
    ).rejects.toMatchObject({
      kind: "unsupported",
    });
  });

  it("maps Docker errors and treats 'already started' as success", async () => {
    const { socketPath } = await fakeDocker();
    const client = createDockerClient({ socketPaths: [socketPath] });
    await expect(client.controlContainer(ID_PROXY, "start")).resolves.toBeUndefined();
    await expect(client.controlContainer(ID_DB, "stop")).rejects.toMatchObject({
      kind: "conflict",
    });
    await expect(client.controlContainer("f".repeat(64), "start")).rejects.toMatchObject({
      kind: "not-found",
    });
  });

  it("reports a missing socket as unavailable", async () => {
    const client = createDockerClient({ socketPaths: [join(tmpdir(), "no-such-docker.sock")] });
    await expect(client.listContainers()).rejects.toBeInstanceOf(DockerError);
    expect((await client.status()).status).toEqual({ available: false, reason: "socket-missing" });
  });

  it("streams demultiplexed logs and filtered events", async () => {
    const { socketPath } = await fakeDocker();
    const client = createDockerClient({ socketPaths: [socketPath] });
    const lines = [];
    for await (const line of client.logs(
      ID_DB,
      { tail: 10, follow: false },
      new AbortController().signal,
    ))
      lines.push(line);
    expect(lines).toEqual([
      { stream: "stdout", ts: Date.parse("2026-10-10T10:00:00Z"), line: "ready" },
    ]);

    const controller = new AbortController();
    const events = [];
    for await (const event of client.events(controller.signal)) {
      events.push(event);
      controller.abort();
    }
    expect(events).toEqual([
      { type: "container", action: "die", id: ID_DB, name: "app_db", at: 2000 },
    ]);
  });
});

describe("docker simulator", () => {
  it("produces nonnegative, increasing cumulative counters over multiple CPU cycles", async () => {
    let now = 1_760_000_000_000;
    const docker = createDockerSimulator({ now: () => now });
    const ids = (await docker.listContainers())
      .filter((c) => c.state === "running")
      .map((c) => c.id);
    let previous = await docker.stats(ids);
    for (let second = 1; second <= 100; second++) {
      now += 1_000;
      const samples = await docker.stats(ids);
      for (const [index, sample] of samples.entries()) {
        expect(ContainerStatsSampleSchema.safeParse(sample).success).toBe(true);
        expect(sample.cpuTotalNs).toBeGreaterThan(previous[index]!.cpuTotalNs);
        expect(sample.systemCpuNs).toBeGreaterThan(previous[index]!.systemCpuNs!);
      }
      previous = samples;
    }
  });
  it("behaves like Docker without touching the host", async () => {
    const docker = createDockerSimulator({ now: () => 1_760_000_000_000 });
    const containers = await docker.listContainers();
    expect(containers.length).toBeGreaterThan(5);
    const old = containers.find((c) => c.name === "old-test")!;
    await docker.controlContainer(old.id, "start");
    expect((await docker.listContainers()).find((c) => c.name === "old-test")?.state).toBe(
      "running",
    );
    await expect(docker.removeVolume("cloud_db")).rejects.toMatchObject({ kind: "conflict" });
    await expect(docker.removeVolume("orphan_volume")).resolves.toBeUndefined();
    const networks = await docker.listNetworks();
    await expect(
      docker.removeNetwork(networks.find((n) => n.name === "bridge")!.id),
    ).rejects.toMatchObject({ kind: "invalid" });
    const down = await docker.runCompose(
      "media",
      "/srv/media",
      ["/srv/media/compose.yaml"],
      "down",
    );
    expect(down.ok).toBe(true);
    expect((await docker.listContainers()).some((c) => c.project === "media")).toBe(false);
    // `down` keeps volumes.
    expect((await docker.listVolumes()).some((v) => v.name === "media_config")).toBe(true);
    await docker.runCompose("media", "/srv/media", ["/srv/media/compose.yaml"], "up");
    expect((await docker.listContainers()).filter((c) => c.project === "media")).toHaveLength(2);
  });
});
