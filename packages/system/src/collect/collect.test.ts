import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  HardwareStatusSchema,
  MetricsSampleSchema,
  NetworkStatusSchema,
  ProcessListSchema,
  StorageUsageSchema,
} from "@everyos/shared/schemas";
import { describe, expect, it } from "vitest";
import { CommandError, findExecutable, runCommand, streamLines } from "../exec.ts";
import { mapLimit, readBytesOrNull } from "../fs-utils.ts";
import { createSimulator } from "../simulated/simulator.ts";
import { collectHardware } from "./hardware.ts";
import { collectMetrics } from "./metrics.ts";
import { collectNetwork, createInternetProbe } from "./network.ts";
import { collectProcesses } from "./processes.ts";
import { collectStorage } from "./storage.ts";

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function piRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "otk-pi-"));
  write(
    root,
    "/proc/stat",
    "cpu  100 0 50 800 10 0 5 0 0 0\ncpu0 50 0 25 400 5 0 3 0 0 0\ncpu1 50 0 25 400 5 0 2 0 0 0\nbtime 1760000000\n",
  );
  write(
    root,
    "/proc/meminfo",
    "MemTotal: 8000000 kB\nMemFree: 1000000 kB\nMemAvailable: 6000000 kB\nBuffers: 100 kB\nCached: 2000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
  );
  write(root, "/proc/loadavg", "0.50 0.40 0.30 1/200 999\n");
  write(root, "/proc/uptime", "3600.5 7000.1\n");
  write(
    root,
    "/proc/net/dev",
    "h1\nh2\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\nbr_kasm_sidecar: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n",
  );
  // Layout observed on a Raspberry Pi 5 (Ubuntu 26.04): only hardware NICs have `device`.
  mkdirSync(join(root, "/sys/class/net/eth0/device"), { recursive: true });
  mkdirSync(join(root, "/sys/class/net/br_kasm_sidecar/bridge"), { recursive: true });
  write(
    root,
    "/proc/diskstats",
    " 259 0 nvme0n1 10 0 100 5 20 0 200 6 0 7 11 0 0 0 0 0 0\n 259 1 nvme0n1p1 1 0 2 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n",
  );
  mkdirSync(join(root, "/sys/block/nvme0n1"), { recursive: true });
  write(root, "/sys/class/thermal/thermal_zone0/type", "cpu-thermal\n");
  write(root, "/sys/class/thermal/thermal_zone0/temp", "51234\n");
  write(root, "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", "2400000\n");
  write(root, "/sys/devices/system/cpu/cpu1/cpufreq/scaling_cur_freq", "1500000\n");
  write(root, "/sys/class/hwmon/hwmon0/name", "cpu_thermal\n");
  write(root, "/sys/class/hwmon/hwmon0/temp1_input", "51234\n");
  write(root, "/sys/class/hwmon/hwmon2/name", "nvme\n");
  write(root, "/sys/class/hwmon/hwmon2/temp1_input", "41850\n");
  write(root, "/sys/class/hwmon/hwmon2/temp2_input", "41850\n");
  write(root, "/sys/class/hwmon/hwmon4/name", "pwmfan\n");
  write(root, "/sys/class/hwmon/hwmon4/fan1_input", "3120\n");
  write(root, "/sys/devices/platform/soc/soc:firmware/get_throttled", "0x50000\n");
  return root;
}

describe("collectors on a Raspberry Pi 5 fixture", () => {
  it("collects raw metrics that satisfy the protocol schema", async () => {
    const sample = await collectMetrics({
      paths: { root: piRoot(), platform: "linux" },
      now: () => 42,
    });
    expect(MetricsSampleSchema.parse(sample)).toEqual(sample);
    expect(sample).toMatchObject({
      at: 42,
      uptimeSeconds: 3600.5,
      load: [0.5, 0.4, 0.3],
      // CPU zones come from thermal; drive temperatures from hwmon (no smartctl needed).
      thermal: [
        { zone: "thermal_zone0", type: "cpu-thermal", celsius: 51.2 },
        { zone: "hwmon2", type: "nvme", celsius: 41.9 },
      ],
      cpuFrequencyMHz: [2400, 1500],
      fans: [{ name: "pwmfan/fan1", rpm: 3120 }],
    });
    expect(sample.cpu?.cores).toHaveLength(2);
    expect(sample.disks?.map((d) => d.name)).toEqual(["nvme0n1"]);
    expect(sample.network).toMatchObject([
      { name: "eth0", rxBytes: 1000, physical: true },
      { name: "br_kasm_sidecar", physical: false },
    ]);
  });

  it("reads Raspberry Pi throttling from the firmware node", async () => {
    const status = await collectHardware({
      paths: { root: piRoot(), platform: "linux" },
      isRaspberryPi: true,
    });
    expect(HardwareStatusSchema.parse(status)).toEqual(status);
    expect(status.throttling).toMatchObject({ status: { available: true }, raw: "0x50000" });
    expect(status.throttling.flags).toMatchObject({
      underVoltage: false,
      underVoltageOccurred: true,
      throttledOccurred: true,
    });
    expect(status.nvme.status).toEqual({ available: false, reason: "not-detected" });
  });

  it("reports why hardware data is missing on other hosts", async () => {
    const generic = await collectHardware({
      paths: { root: piRoot(), platform: "linux" },
      isRaspberryPi: false,
    });
    expect(generic.throttling.status).toEqual({ available: false, reason: "unsupported-hardware" });
    const mac = await collectHardware({
      paths: { root: "/", platform: "darwin" },
      isRaspberryPi: false,
    });
    expect(mac.throttling.status.reason).toBe("not-linux");
  });

  it("measures storage with statfs on mounted filesystems", async () => {
    const root = piRoot();
    write(root, "/proc/mounts", `/dev/nvme0n1p2 / ext4 rw,relatime 0 0\nproc /proc proc rw 0 0\n`);
    const usage = await collectStorage({ paths: { root, platform: "linux" } });
    expect(StorageUsageSchema.parse(usage)).toEqual(usage);
    expect(usage.mounts).toHaveLength(1);
    expect(usage.mounts[0]).toMatchObject({
      device: "/dev/nvme0n1p2",
      mountpoint: "/",
      fsType: "ext4",
    });
    expect(usage.mounts[0]!.totalBytes).toBeGreaterThan(0);
  });

  it("describes interfaces, gateways and DNS", async () => {
    const root = piRoot();
    write(root, "/sys/class/net/eth0/operstate", "up\n");
    write(root, "/sys/class/net/eth0/address", "d8:3a:dd:00:11:22\n");
    write(root, "/sys/class/net/eth0/mtu", "1500\n");
    write(root, "/sys/class/net/eth0/speed", "1000\n");
    write(root, "/sys/class/net/eth0/type", "1\n");
    write(root, "/sys/class/net/wlan0/operstate", "down\n");
    mkdirSync(join(root, "/sys/class/net/wlan0/wireless"), { recursive: true });
    write(root, "/sys/class/net/tailscale0/operstate", "unknown\n");
    // A container network link: Ethernet type, nominal 10000 Mbit/s, but no hardware.
    write(root, "/sys/class/net/k-p-e-470f75/operstate", "up\n");
    write(root, "/sys/class/net/k-p-e-470f75/type", "1\n");
    write(root, "/sys/class/net/k-p-e-470f75/speed", "10000\n");
    write(
      root,
      "/proc/net/route",
      "Iface\tDestination\tGateway\tFlags\nnope\neth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n",
    );
    write(root, "/etc/resolv.conf", "nameserver 127.0.0.53\n");
    write(root, "/run/systemd/resolve/resolv.conf", "nameserver 192.168.1.1\n");
    const status = await collectNetwork({
      paths: { root, platform: "linux" },
      internet: () => Promise.resolve({ state: "online", checkedAt: 1, latencyMs: 12 }),
    });
    expect(NetworkStatusSchema.parse(status)).toEqual(status);
    expect(status.interfaces.map((i) => [i.name, i.kind, i.up])).toEqual([
      ["br_kasm_sidecar", "bridge", false],
      ["eth0", "ethernet", true],
      ["k-p-e-470f75", "virtual", true],
      ["tailscale0", "tailscale", false],
      ["wlan0", "wireless", false],
    ]);
    expect(status.interfaces.find((i) => i.name === "k-p-e-470f75")?.speedMbps).toBeNull();
    expect(status.interfaces.find((i) => i.name === "eth0")).toMatchObject({
      mac: "d8:3a:dd:00:11:22",
      mtu: 1500,
      speedMbps: 1000,
    });
    expect(status.gateways).toEqual([
      { interface: "eth0", address: "192.168.1.1", family: "ipv4" },
    ]);
    expect(status.dns).toEqual(["192.168.1.1"]);
  });

  it("disables the internet probe when no targets are configured", async () => {
    expect(await createInternetProbe([])()).toEqual({
      state: "disabled",
      checkedAt: null,
      latencyMs: null,
    });
  });

  it("lists processes on this machine", async () => {
    const list = await collectProcesses({ sort: "memory", limit: 5 });
    expect(ProcessListSchema.parse(list)).toEqual(list);
    expect(list.processes.length).toBeGreaterThan(0);
    expect(list.processes.length).toBeLessThanOrEqual(5);
  });

  it("collects real metrics from the machine running the tests", async () => {
    const sample = await collectMetrics();
    expect(MetricsSampleSchema.safeParse(sample).success).toBe(true);
    expect(sample.cpu?.cores.length).toBeGreaterThan(0);
  });
});

describe("command execution", () => {
  it("runs trusted tools by absolute path without a shell", async () => {
    const echo = await findExecutable("echo");
    expect(echo).toMatch(/^\/.+\/echo$/);
    expect(await runCommand(echo!, ["a; rm -rf /", "$(id)"])).toBe("a; rm -rf / $(id)\n");
  });

  it("reports missing tools, failures and timeouts distinctly", async () => {
    await expect(runCommand("/nonexistent/tool", [])).rejects.toMatchObject({ kind: "not-found" });
    const sleep = await findExecutable("sleep");
    await expect(runCommand(sleep!, ["5"], { timeoutMs: 100 })).rejects.toMatchObject({
      kind: "timeout",
    });
    const fail = await findExecutable("false");
    await expect(runCommand(fail!, [])).rejects.toBeInstanceOf(CommandError);
    await expect(runCommand(fail!, [], { okExitCodes: [1] })).resolves.toBe("");
  });

  it("streams lines and stops the process when the consumer aborts", async () => {
    const yes = await findExecutable("yes");
    const controller = new AbortController();
    const lines: string[] = [];
    for await (const line of streamLines(yes!, ["everyos"], { signal: controller.signal })) {
      lines.push(line);
      if (lines.length === 3) controller.abort();
    }
    expect(lines).toEqual(["everyos", "everyos", "everyos"]);
  });
});

describe("development simulator", () => {
  it("lists, controls and logs simulated services without touching the host", async () => {
    const simulator = createSimulator(() => 1_760_000_000_000);
    const list = await simulator.services.list((unit) => unit === "ssh.service");
    expect(list.source).toBe("simulated");
    expect(list.units.find((u) => u.name === "ssh.service")?.protected).toBe(true);
    await simulator.services.control("jellyfin.service", "start");
    expect((await simulator.services.get("jellyfin.service", () => false)).active).toBe("active");
    const page = await simulator.logs.query({ limit: 5, unit: "jellyfin.service" });
    expect(page.entries[0]?.message).toContain("start");
    await expect(simulator.services.get("missing.service", () => false)).rejects.toMatchObject({
      kind: "not-found",
    });
  });

  it("pages simulated logs with cursors", async () => {
    const simulator = createSimulator();
    const first = await simulator.logs.query({ limit: 10 });
    const second = await simulator.logs.query({ limit: 10, before: first.entries.at(-1)!.cursor });
    expect(first.entries).toHaveLength(10);
    expect(second.entries[0]!.ts).toBeLessThanOrEqual(first.entries.at(-1)!.ts);
    expect(second.entries.map((e) => e.cursor)).not.toContain(first.entries.at(-1)!.cursor);
  });
});

describe("bounded file reads", () => {
  it("stops at the byte limit and reports missing files as null", async () => {
    const root = mkdtempSync(join(tmpdir(), "otk-read-"));
    write(root, "/big.txt", "x".repeat(10_000));
    expect((await readBytesOrNull(join(root, "big.txt"), 5_000))?.length).toBe(5_000);
    expect((await readBytesOrNull(join(root, "big.txt")))?.length).toBe(10_000);
    expect(await readBytesOrNull(join(root, "missing.txt"))).toBeNull();
  });

  it("limits concurrency and keeps result order", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return n * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});
