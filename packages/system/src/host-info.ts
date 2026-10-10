import * as os from "node:os";
import type { SystemInfo } from "@otuken/shared";
import { detectCapabilities } from "./capabilities.ts";
import { readTextOrNull } from "./fs-utils.ts";
import { hostPath, REAL_HOST, type HostPaths } from "./host-paths.ts";
import { cleanDeviceTreeString, cpuModelFromCpuinfo, parseOsRelease } from "./parsers.ts";

/** The subset of node:os used here, injectable for tests. */
export interface OsFacts {
  hostname(): string;
  arch(): string;
  release(): string;
  type(): string;
  cpus(): Array<{ model: string }>;
  totalmem(): number;
  uptime(): number;
}

export interface CollectOptions {
  paths?: HostPaths;
  osFacts?: OsFacts;
  now?: () => number;
}

async function readHardwareModel(paths: HostPaths): Promise<string | null> {
  for (const candidate of ["/proc/device-tree/model", "/sys/firmware/devicetree/base/model"]) {
    const text = await readTextOrNull(hostPath(paths, candidate), 512);
    if (text) {
      const model = cleanDeviceTreeString(text);
      if (model) return model;
    }
  }
  // x86 machines expose DMI data instead of a device tree.
  const vendor = (
    await readTextOrNull(hostPath(paths, "/sys/class/dmi/id/sys_vendor"), 256)
  )?.trim();
  const product = (
    await readTextOrNull(hostPath(paths, "/sys/class/dmi/id/product_name"), 256)
  )?.trim();
  const dmi = [vendor, product].filter(
    (part) => part && !/^(To be filled|System Product Name|Default string)/i.test(part),
  );
  return dmi.length > 0 ? dmi.join(" ") : null;
}

async function readOs(paths: HostPaths, facts: OsFacts): Promise<SystemInfo["os"]> {
  if (paths.platform === "linux") {
    const text =
      (await readTextOrNull(hostPath(paths, "/etc/os-release"))) ??
      (await readTextOrNull(hostPath(paths, "/usr/lib/os-release")));
    if (text) {
      const fields = parseOsRelease(text);
      const name = fields.NAME ?? "Linux";
      return {
        id: fields.ID ?? null,
        name,
        version: fields.VERSION_ID ?? null,
        prettyName: fields.PRETTY_NAME ?? name,
      };
    }
  }
  const name = paths.platform === "darwin" ? "macOS" : facts.type();
  return { id: paths.platform, name, version: null, prettyName: `${name} ${facts.release()}` };
}

/**
 * Collects host information from real interfaces only. Missing data is
 * reported as null / unavailable instead of being guessed.
 */
export async function collectSystemInfo(options: CollectOptions = {}): Promise<SystemInfo> {
  const paths = options.paths ?? REAL_HOST;
  const facts = options.osFacts ?? os;
  const now = options.now ?? Date.now;

  const [osInfo, hardwareModel, cpuinfo] = await Promise.all([
    readOs(paths, facts),
    readHardwareModel(paths),
    paths.platform === "linux"
      ? readTextOrNull(hostPath(paths, "/proc/cpuinfo"), 256 * 1024)
      : Promise.resolve(null),
  ]);
  const cpus = facts.cpus();
  const nodeModel = cpus[0]?.model?.trim();
  const cpuModel = (cpuinfo ? cpuModelFromCpuinfo(cpuinfo) : null) ?? (nodeModel || "unknown");
  const uptimeSeconds = facts.uptime();
  const collectedAt = now();

  return {
    source: "host",
    hostname: facts.hostname(),
    platform: paths.platform,
    arch: facts.arch(),
    kernel: facts.release(),
    os: osInfo,
    cpu: { model: cpuModel, cores: cpus.length },
    memory: { totalBytes: facts.totalmem() },
    uptimeSeconds,
    bootTime: Math.round(collectedAt - uptimeSeconds * 1000),
    hardware: {
      model: hardwareModel,
      isRaspberryPi: hardwareModel?.includes("Raspberry Pi") ?? false,
    },
    capabilities: await detectCapabilities(paths, hardwareModel),
    collectedAt,
  };
}
