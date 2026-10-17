import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SystemInfoSchema } from "@everyos/shared/schemas";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectRebootStatus,
  collectSystemInfo,
  compareKernelReleases,
  cpuModelFromCpuinfo,
  parseOsRelease,
  type OsFacts,
} from "./index.ts";
import { RebootStatusSchema } from "@everyos/shared/schemas";

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
  hostname: () => "everyos-pi",
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
      hostname: "everyos-pi",
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

describe("collectRebootStatus", () => {
  const host = () => {
    const root = mkdtempSync(join(tmpdir(), "everyos-reboot-"));
    mkdirSync(join(root, "run"), { recursive: true });
    mkdirSync(join(root, "boot"), { recursive: true });
    // Another flavour and non-kernel files never count.
    for (const name of [
      "vmlinuz-6.8.0-2-raspi",
      "vmlinuz-6.9.0-1-generic",
      "initrd.img-9.9.9-raspi",
    ])
      writeFileSync(join(root, "boot", name), "");
    return root;
  };

  it("reports the distribution's marker with the packages that asked for it", async () => {
    const root = host();
    writeFileSync(join(root, "run/reboot-required"), "*** System restart required ***\n");
    writeFileSync(
      join(root, "run/reboot-required.pkgs"),
      "linux-image-6.8.0-2-raspi\nlibc6\nlibc6\n$(evil)\n",
    );
    const status = await collectRebootStatus({
      paths: { root, platform: "linux" },
      kernel: "6.8.0-2-raspi",
    });
    expect(RebootStatusSchema.parse(status)).toEqual({
      source: "host",
      required: true,
      reasons: ["flag"],
      packages: ["linux-image-6.8.0-2-raspi", "libc6"],
      kernel: "6.8.0-2-raspi",
    });
  });

  it("notices a newer kernel in /boot, or the running one removed", async () => {
    const root = host();
    const status = (kernel: string) =>
      collectRebootStatus({ paths: { root, platform: "linux" }, kernel });
    expect(await status("6.8.0-2-raspi")).toMatchObject({ required: false, reasons: [] });
    // Upgraded: 6.8.0-10 sorts after 6.8.0-2 although "1" < "2".
    writeFileSync(join(root, "boot/vmlinuz-6.8.0-10-raspi"), "");
    expect(await status("6.8.0-2-raspi")).toMatchObject({
      required: true,
      reasons: ["kernel"],
      packages: [],
    });
    // Removed by autoremove while still running.
    expect(await status("6.8.0-1-raspi")).toMatchObject({ required: true, reasons: ["kernel"] });
    expect(await status("6.8.0-10-raspi")).toMatchObject({ required: false });
    // Raspberry Pi OS names, and hosts without kernels in /boot.
    writeFileSync(join(root, "boot/vmlinuz-6.12.25+rpt-rpi-v8"), "");
    writeFileSync(join(root, "boot/vmlinuz-6.12.34+rpt-rpi-2712"), "");
    expect(await status("6.12.25+rpt-rpi-v8")).toMatchObject({ required: false });
    expect(await status("6.12.20+rpt-rpi-2712")).toMatchObject({ required: true });
    expect(await status("6.1.0-26-arm64")).toMatchObject({ required: false });
    expect(compareKernelReleases("6.8.0-49-generic", "6.8.0-50-generic")).toBe(-1);
    expect(compareKernelReleases("6.12.1+rpt-rpi-v8", "6.6.51+rpt-rpi-v8")).toBe(1);
    expect(
      await collectRebootStatus({ paths: { root, platform: "darwin" }, kernel: "6.8.0-1-raspi" }),
    ).toMatchObject({ required: false, kernel: null });
  });
});
