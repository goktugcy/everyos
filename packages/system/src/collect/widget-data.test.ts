import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AptUpdatesSchema, SocketSummarySchema, TimerSummarySchema } from "@otuken/shared/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { createDockerClient, parsePostgresStats, POSTGRES_STATS_SQL } from "../docker/client.ts";
import { parseAptUpgradable } from "../linux/apt.ts";
import { decodeAddress, isListening, parseProcNet } from "../linux/sockets.ts";
import { parseListTimers } from "../linux/systemd.ts";
import { createSimulator } from "../simulated/simulator.ts";
import { UnavailableError } from "../unavailable.ts";
import { collectSockets } from "./sockets.ts";

/* Formats as printed by Linux 7.0 (Ubuntu 26.04) on a Raspberry Pi 5; addresses invented. */
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 21304 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1D2E 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 21400 1 0000000000000000 100 0 0 10 0
   2: 1401A8C0:0016 6401A8C0:D431 01 00000000:00000000 02:000A7B2E 00000000     0        0 55120 4 0000000000000000 20 4 29 10 -1
   3: 1401A8C0:0016 6401A8C0:D432 06 00000000:00000000 03:00000F9C 00000000     0        0 0 3 0000000000000000
`;
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 21306 1 0000000000000000 100 0 0 10 0
   1: 0000000000000000FFFF00000100007F:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 33001 1 0000000000000000 100 0 0 10 0
`;
const UDP = `   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  412: 3500007F:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000   991        0 20211 2 0000000000000000 0
  900: 1401A8C0:B4C2 08080808:0035 01 00000000:00000000 00:00000000 00000000     0        0 0 2 0000000000000000 0
`;

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe("sockets", () => {
  it("decodes /proc/net addresses", () => {
    expect(decodeAddress("0100007F")).toBe("127.0.0.1");
    expect(decodeAddress("00000000000000000000000000000000")).toBe("::");
    expect(decodeAddress("0000000000000000FFFF00000100007F")).toBe("127.0.0.1");
    expect(decodeAddress("B80D0120000000000000000001000000")).toBe("2001:db8::1");
  });

  it("finds listening sockets and counts connections", async () => {
    const tcp = parseProcNet(TCP, "tcp");
    expect(tcp.filter(isListening).map((s) => `${s.address}:${s.port}`)).toEqual([
      "0.0.0.0:22",
      "127.0.0.1:7470",
    ]);
    const root = mkdtempSync(join(tmpdir(), "otk-net-"));
    write(root, "/proc/net/tcp", TCP);
    write(root, "/proc/net/tcp6", TCP6);
    write(root, "/proc/net/udp", UDP);
    // A process owning one of the sockets (fd symlinks are what the root agent can read).
    write(root, "/proc/1625/comm", "sshd\n");
    mkdirSync(join(root, "/proc/1625/fd"), { recursive: true });
    const { symlinkSync } = await import("node:fs");
    symlinkSync("socket:[21304]", join(root, "/proc/1625/fd/3"));
    const summary = await collectSockets({ paths: { root, platform: "linux" } });
    expect(SocketSummarySchema.parse(summary)).toEqual(summary);
    expect(summary.listening).toEqual([
      { protocol: "tcp", address: "0.0.0.0", port: 22, process: "sshd" },
      { protocol: "tcp", address: "::", port: 22, process: null },
      { protocol: "udp", address: "127.0.0.53", port: 53, process: null },
      { protocol: "tcp", address: "127.0.0.1", port: 7470, process: null },
      { protocol: "tcp", address: "127.0.0.1", port: 8080, process: null },
    ]);
    expect(summary.connections).toEqual({ established: 1, timeWait: 1, other: 0 });
  });

  it("explains that sockets need Linux", async () => {
    await expect(
      collectSockets({ paths: { root: "/", platform: "darwin" } }),
    ).rejects.toBeInstanceOf(UnavailableError);
  });
});

describe("apt and timers", () => {
  it("parses upgradable packages and flags security updates", () => {
    const updates = parseAptUpgradable(
      [
        "Listing...",
        "curl/noble-updates 8.5.0-2ubuntu10.7 arm64 [upgradable from: 8.5.0-2ubuntu10.6]",
        "openssl/noble-updates,noble-security 3.0.13-0ubuntu3.6 arm64 [upgradable from: 3.0.13-0ubuntu3.5]",
        "WARNING: apt does not have a stable CLI interface.",
      ].join("\n"),
    );
    expect(updates).toEqual({
      total: 2,
      security: 1,
      packages: [
        {
          name: "openssl",
          version: "3.0.13-0ubuntu3.6",
          currentVersion: "3.0.13-0ubuntu3.5",
          suites: "noble-updates,noble-security",
          security: true,
        },
        {
          name: "curl",
          version: "8.5.0-2ubuntu10.7",
          currentVersion: "8.5.0-2ubuntu10.6",
          suites: "noble-updates",
          security: false,
        },
      ],
    });
    expect(
      AptUpdatesSchema.safeParse({ source: "host", listsUpdatedAt: null, ...updates }).success,
    ).toBe(true);
  });

  it("parses systemd timers (microsecond timestamps)", async () => {
    const timers = parseListTimers([
      {
        next: 1_791_700_000_000_000,
        left: 1,
        last: 1_791_600_000_000_000,
        passed: 1,
        unit: "apt-daily.timer",
        activates: "apt-daily.service",
      },
      {
        next: 0,
        left: 0,
        last: null,
        passed: null,
        unit: "fstrim.timer",
        activates: "fstrim.service",
      },
      { bogus: true },
    ]);
    expect(timers).toEqual([
      {
        unit: "apt-daily.timer",
        activates: "apt-daily.service",
        next: 1_791_700_000_000,
        last: 1_791_600_000_000,
      },
      { unit: "fstrim.timer", activates: "fstrim.service", next: null, last: null },
    ]);
    const simulated = await createSimulator(() => 1_760_000_000_000).services.timers();
    expect(TimerSummarySchema.parse(simulated).timers.length).toBeGreaterThan(0);
  });
});

/* ----------------------------- postgres exec ----------------------------- */

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length > 0) await new Promise((resolve) => servers.pop()!.close(resolve));
});

describe("postgres statistics", () => {
  it("runs only the fixed read-only query, in PostgreSQL containers", async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), "otk-pg-")), "docker.sock");
    const bodies: unknown[] = [];
    const id = "a".repeat(64);
    const execId = "e".repeat(64);
    const containers = [
      {
        Id: id,
        Names: ["/app_db"],
        Image: "postgres:17-alpine",
        ImageID: "x",
        Created: 1,
        State: "running",
        Status: "Up",
        Labels: {},
        Ports: [],
        Mounts: [],
      },
      {
        Id: "b".repeat(64),
        Names: ["/web"],
        Image: "nginx:1.29",
        ImageID: "y",
        Created: 1,
        State: "running",
        Status: "Up",
        Labels: {},
        Ports: [],
        Mounts: [],
      },
    ];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        if (raw) bodies.push(JSON.parse(raw));
        const path = new URL(req.url ?? "/", "http://docker").pathname.replace(/^\/v[\d.]+/, "");
        const json = (status: number, body: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json", "Api-Version": "1.51" });
          res.end(JSON.stringify(body));
        };
        if (path === "/_ping") return json(200, "OK");
        if (path === "/containers/json") return json(200, containers);
        if (path === `/containers/${id}/exec`) return json(201, { Id: execId });
        if (path === `/exec/${execId}/start`) {
          const payload = Buffer.from(
            '{"connections":4,"maxConnections":100,"databases":[{"name":"app","sizeBytes":8192}]}\n',
          );
          const header = Buffer.alloc(8);
          header[0] = 1;
          header.writeUInt32BE(payload.length, 4);
          res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
          res.end(Buffer.concat([header, payload]));
          return;
        }
        if (path === `/exec/${execId}/json`) return json(200, { ExitCode: 0 });
        return json(404, { message: "not found" });
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    servers.push(server);
    const docker = createDockerClient({ socketPaths: [socketPath] });

    expect(await docker.postgresStats("app_db", "postgres", "app")).toEqual({
      connections: 4,
      maxConnections: 100,
      databases: [{ name: "app", sizeBytes: 8192 }],
    });
    expect(bodies[0]).toMatchObject({
      Cmd: [
        "psql",
        "-U",
        "postgres",
        "-d",
        "app",
        "-AtqX",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        POSTGRES_STATS_SQL,
      ],
    });
    expect(POSTGRES_STATS_SQL).toMatch(/^BEGIN READ ONLY;/);
    await expect(docker.postgresStats("web", "postgres", "app")).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(docker.postgresStats("app_db", "postgres; DROP", "app")).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(() => parsePostgresStats("not json")).toThrow();
  });
});
