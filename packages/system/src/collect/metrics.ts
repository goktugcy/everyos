import * as os from "node:os";
import type { CpuTimes, MetricsSample } from "@otuken/shared";
import { listDirOrEmpty, pathKind, readTextOrNull } from "../fs-utils.ts";
import { hostPath, REAL_HOST, type HostPaths } from "../host-paths.ts";
import {
  looksLikeWholeDisk,
  parseDiskstats,
  parseLoadavg,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  parseUptime,
} from "../linux/procfs.ts";

export interface MetricsOptions {
  paths?: HostPaths;
  now?: () => number;
}

async function readThermal(paths: HostPaths): Promise<MetricsSample["thermal"]> {
  const base = hostPath(paths, "/sys/class/thermal");
  const zones = (await listDirOrEmpty(base))
    .filter((name) => name.startsWith("thermal_zone"))
    .sort();
  const out: NonNullable<MetricsSample["thermal"]> = [];
  for (const zone of zones.slice(0, 64)) {
    const temp = Number((await readTextOrNull(`${base}/${zone}/temp`, 64))?.trim());
    if (!Number.isFinite(temp)) continue;
    const type = (await readTextOrNull(`${base}/${zone}/type`, 128))?.trim() ?? zone;
    out.push({ zone, type, celsius: Math.round(temp / 100) / 10 });
  }
  return out.length > 0 ? out : null;
}

async function readCpuFrequencies(paths: HostPaths): Promise<MetricsSample["cpuFrequencyMHz"]> {
  const base = hostPath(paths, "/sys/devices/system/cpu");
  const cpus = (await listDirOrEmpty(base))
    .filter((name) => /^cpu\d+$/.test(name))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  const out: number[] = [];
  for (const cpu of cpus.slice(0, 512)) {
    const khz = Number(
      (await readTextOrNull(`${base}/${cpu}/cpufreq/scaling_cur_freq`, 32))?.trim(),
    );
    if (Number.isFinite(khz) && khz > 0) out.push(Math.round(khz / 1000));
  }
  return out.length > 0 ? out : null;
}

/** hwmon drivers that report drive temperatures (readable without smartctl or root). */
const DRIVE_SENSORS = new Set(["nvme", "drivetemp"]);

/** Fans and drive temperatures from hwmon (CPU zones come from /sys/class/thermal). */
async function readHwmon(paths: HostPaths): Promise<{
  fans: NonNullable<MetricsSample["fans"]>;
  drives: NonNullable<MetricsSample["thermal"]>;
}> {
  const base = hostPath(paths, "/sys/class/hwmon");
  const fans: NonNullable<MetricsSample["fans"]> = [];
  const drives: NonNullable<MetricsSample["thermal"]> = [];
  for (const hwmon of (await listDirOrEmpty(base)).sort().slice(0, 32)) {
    const files = await listDirOrEmpty(`${base}/${hwmon}`);
    const name = (await readTextOrNull(`${base}/${hwmon}/name`, 64))?.trim() ?? hwmon;
    for (const file of files.filter((f) => /^fan\d+_input$/.test(f)).sort()) {
      const rpm = Number((await readTextOrNull(`${base}/${hwmon}/${file}`, 32))?.trim());
      if (Number.isFinite(rpm) && rpm >= 0)
        fans.push({ name: `${name}/${file.replace("_input", "")}`, rpm });
    }
    if (DRIVE_SENSORS.has(name) && files.includes("temp1_input")) {
      // temp1 is the composite (overall) drive temperature.
      const milli = Number((await readTextOrNull(`${base}/${hwmon}/temp1_input`, 32))?.trim());
      if (Number.isFinite(milli))
        drives.push({ zone: hwmon, type: name, celsius: Math.round(milli / 100) / 10 });
    }
  }
  return { fans, drives };
}

/** Interfaces backed by a device (PCIe, USB, SDIO, virtio…) rather than software links. */
async function readPhysicalInterfaces(paths: HostPaths): Promise<Set<string>> {
  const base = hostPath(paths, "/sys/class/net");
  const physical = new Set<string>();
  for (const name of (await listDirOrEmpty(base)).slice(0, 256)) {
    if ((await pathKind(`${base}/${name}/device`)) === "directory") physical.add(name);
  }
  return physical;
}

function nodeCpuTimes(): { total: CpuTimes; cores: CpuTimes[] } {
  // node:os reports milliseconds; rates computed from it are equivalent to tick-based ones.
  const cores = os.cpus().map(({ times }) => ({
    user: times.user,
    nice: times.nice,
    system: times.sys,
    idle: times.idle,
    iowait: 0,
    irq: times.irq,
    softirq: 0,
    steal: 0,
  }));
  const total = cores.reduce<CpuTimes>(
    (sum, core) => ({
      user: sum.user + core.user,
      nice: sum.nice + core.nice,
      system: sum.system + core.system,
      idle: sum.idle + core.idle,
      iowait: 0,
      irq: sum.irq + core.irq,
      softirq: 0,
      steal: 0,
    }),
    { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0 },
  );
  return { total, cores };
}

/**
 * Raw counters for the metrics pipeline. Everything comes from cheap kernel
 * interfaces; values that a host does not expose are null.
 */
export async function collectMetrics(options: MetricsOptions = {}): Promise<MetricsSample> {
  const paths = options.paths ?? REAL_HOST;
  const now = options.now ?? Date.now;

  if (paths.platform !== "linux") {
    // Development on non-Linux hosts: real values from node:os where available.
    return {
      source: "host",
      at: now(),
      uptimeSeconds: os.uptime(),
      cpu: nodeCpuTimes(),
      memory: {
        totalBytes: os.totalmem(),
        availableBytes: os.freemem(),
        freeBytes: os.freemem(),
        buffersBytes: 0,
        cachedBytes: 0,
        swapTotalBytes: 0,
        swapFreeBytes: 0,
      },
      load: os.loadavg() as [number, number, number],
      network: null,
      disks: null,
      thermal: null,
      cpuFrequencyMHz: null,
      fans: null,
    };
  }

  const read = (path: string, max?: number) => readTextOrNull(hostPath(paths, path), max);
  const [
    stat,
    meminfo,
    loadavg,
    uptime,
    netDev,
    diskstats,
    blockDevices,
    zones,
    frequencies,
    hwmon,
    physical,
  ] = await Promise.all([
    read("/proc/stat", 256 * 1024),
    read("/proc/meminfo"),
    read("/proc/loadavg", 256),
    read("/proc/uptime", 256),
    read("/proc/net/dev", 256 * 1024),
    read("/proc/diskstats", 256 * 1024),
    listDirOrEmpty(hostPath(paths, "/sys/block")),
    readThermal(paths),
    readCpuFrequencies(paths),
    readHwmon(paths),
    readPhysicalInterfaces(paths),
  ]);
  const thermal = [...(zones ?? []), ...hwmon.drives];
  const disks = new Set(blockDevices);
  const isDisk = (name: string) =>
    disks.size > 0 ? disks.has(name) && looksLikeWholeDisk(name) : looksLikeWholeDisk(name);
  const cpu = stat ? parseProcStat(stat) : null;

  return {
    source: "host",
    at: now(),
    uptimeSeconds: (uptime ? parseUptime(uptime) : null) ?? os.uptime(),
    cpu: cpu ? { total: cpu.total, cores: cpu.cores } : null,
    memory: meminfo ? parseMeminfo(meminfo) : null,
    load: loadavg ? parseLoadavg(loadavg) : null,
    network: netDev ? parseNetDev(netDev, (name) => physical.has(name)) : null,
    disks: diskstats ? parseDiskstats(diskstats, isDisk) : null,
    thermal: thermal.length > 0 ? thermal : null,
    cpuFrequencyMHz: frequencies,
    fans: hwmon.fans.length > 0 ? hwmon.fans : null,
  };
}
