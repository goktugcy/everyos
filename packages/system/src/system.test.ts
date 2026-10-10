import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SystemInfoSchema } from "@otuken/shared/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { collectSystemInfo, cpuModelFromCpuinfo, parseOsRelease, type OsFacts } from "./index.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

async function listenSocket(root: string, path: string): Promise<void> {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(full, resolve));
}

const PI5_CPUINFO = `processor\t: 0
BogoMIPS\t: 108.00
Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp
CPU implementer\t: 0x41
CPU architecture: 8
CPU variant\t: 0x4
CPU part\t: 0xd0b
CPU revision\t: 1

Revision\t: d04170
Model\t\t: Raspberry Pi 5 Model B Rev 1.0
`;

const UBUNTU_OS_RELEASE = `PRETTY_NAME="Ubuntu 24.04.3 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.3 LTS (Noble Numbat)"
ID=ubuntu
ID_LIKE=debian
`;

const piFacts: OsFacts = {
  hostname: () => "otuken-pi",
  arch: () => "arm64",
  release: () => "6.8.0-1030-raspi",
  type: () => "Linux",
  cpus: () => Array.from({ length: 4 }, () => ({ model: "" })),
  totalmem: () => 8_454_000_000,
  uptime: () => 3600,
};

describe("parsers", () => {
  it("parses os-release including quoting and comments", () => {
    const parsed = parseOsRelease(
      `# comment\n${UBUNTU_OS_RELEASE}BAD LINE\nQUOTED='single'\nESC="a \\"b\\""\n`,
    );
    expect(parsed).toMatchObject({
      ID: "ubuntu",
      VERSION_ID: "24.04",
      PRETTY_NAME: "Ubuntu 24.04.3 LTS",
      QUOTED: "single",
      ESC: 'a "b"',
    });
  });

  it("derives ARM CPU models from part numbers", () => {
    expect(cpuModelFromCpuinfo(PI5_CPUINFO)).toBe("ARM Cortex-A76");
    expect(cpuModelFromCpuinfo("model name\t: AMD Ryzen 7 7840U\n")).toBe("AMD Ryzen 7 7840U");
    expect(cpuModelFromCpuinfo("")).toBeNull();
  });
});

describe("collectSystemInfo", () => {
  it("reads a Raspberry Pi 5 running Ubuntu from host interfaces", async () => {
    const root = mkdtempSync(join(tmpdir(), "otk-host-"));
    write(root, "/etc/os-release", UBUNTU_OS_RELEASE);
    write(root, "/proc/device-tree/model", "Raspberry Pi 5 Model B Rev 1.0\0");
    write(root, "/proc/cpuinfo", PI5_CPUINFO);
    write(root, "/proc/stat", "cpu  1 2 3 4\n");
    mkdirSync(join(root, "/run/systemd/system"), { recursive: true });
    write(root, "/sys/class/thermal/thermal_zone0/temp", "48500\n");
    await listenSocket(root, "/run/systemd/journal/socket");
    await listenSocket(root, "/var/run/docker.sock");

    const info = await collectSystemInfo({
      paths: { root, platform: "linux" },
      osFacts: piFacts,
      now: () => 10_000_000,
    });
    expect(SystemInfoSchema.parse(info)).toEqual(info);
    expect(info).toMatchObject({
      source: "host",
      hostname: "otuken-pi",
      arch: "arm64",
      os: { id: "ubuntu", version: "24.04", prettyName: "Ubuntu 24.04.3 LTS" },
      cpu: { model: "ARM Cortex-A76", cores: 4 },
      hardware: { model: "Raspberry Pi 5 Model B Rev 1.0", isRaspberryPi: true },
      bootTime: 10_000_000 - 3_600_000,
    });
    expect(info.capabilities).toEqual({
      procfs: { available: true },
      systemd: { available: true },
      journald: { available: true },
      docker: { available: true },
      tailscale: { available: false, reason: "not-detected" },
      thermal: { available: true },
      raspberryPi: { available: true },
    });
  });

  it("reports missing interfaces with reasons instead of guessing", async () => {
    const root = mkdtempSync(join(tmpdir(), "otk-host-"));
    const info = await collectSystemInfo({ paths: { root, platform: "linux" }, osFacts: piFacts });
    expect(info.os).toEqual({
      id: "linux",
      name: "Linux",
      version: null,
      prettyName: "Linux 6.8.0-1030-raspi",
    });
    expect(info.hardware).toEqual({ model: null, isRaspberryPi: false });
    expect(info.capabilities.systemd).toEqual({ available: false, reason: "not-detected" });
    expect(info.capabilities.docker).toEqual({ available: false, reason: "socket-missing" });
    expect(info.capabilities.raspberryPi).toEqual({
      available: false,
      reason: "unsupported-hardware",
    });
  });

  it("marks Linux-only capabilities as unavailable on other platforms", async () => {
    const root = mkdtempSync(join(tmpdir(), "otk-host-"));
    const info = await collectSystemInfo({
      paths: { root, platform: "darwin" },
      osFacts: {
        ...piFacts,
        type: () => "Darwin",
        release: () => "25.6.0",
        cpus: () => [{ model: "Apple M2" }],
      },
    });
    expect(info.os.prettyName).toBe("macOS 25.6.0");
    expect(info.cpu.model).toBe("Apple M2");
    expect(info.capabilities.systemd).toEqual({ available: false, reason: "not-linux" });
  });

  it("collects real data from the machine running the tests", async () => {
    const info = await collectSystemInfo();
    expect(SystemInfoSchema.safeParse(info).success).toBe(true);
    expect(info.cpu.cores).toBeGreaterThan(0);
    expect(info.memory.totalBytes).toBeGreaterThan(0);
  });
});
