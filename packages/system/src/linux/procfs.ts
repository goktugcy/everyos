import type { CpuTimes, MetricsSample } from "@otuken/shared";

/*
 * Pure parsers for Linux /proc files. Each takes the file content and
 * returns structured data; malformed lines are skipped rather than guessed.
 * Formats: proc(5), Documentation/filesystems/proc.rst and iostats.rst.
 */

const num = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

function cpuTimes(fields: string[]): CpuTimes {
  return {
    user: num(fields[0]),
    nice: num(fields[1]),
    system: num(fields[2]),
    idle: num(fields[3]),
    iowait: num(fields[4]),
    irq: num(fields[5]),
    softirq: num(fields[6]),
    steal: num(fields[7]),
  };
}

/** /proc/stat → aggregate and per-core CPU counters (clock ticks). */
export function parseProcStat(
  text: string,
): { total: CpuTimes; cores: CpuTimes[]; bootTime: number | null } | null {
  let total: CpuTimes | null = null;
  const cores: Array<{ index: number; times: CpuTimes }> = [];
  let bootTime: number | null = null;
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const key = parts[0];
    if (key === "cpu") total = cpuTimes(parts.slice(1));
    else if (key && /^cpu\d+$/.test(key))
      cores.push({ index: Number(key.slice(3)), times: cpuTimes(parts.slice(1)) });
    else if (key === "btime") bootTime = num(parts[1]) * 1000;
  }
  if (!total) return null;
  cores.sort((a, b) => a.index - b.index);
  return { total, cores: cores.map((core) => core.times), bootTime };
}

/** /proc/meminfo → bytes. MemAvailable is required (kernel ≥ 3.14). */
export function parseMeminfo(text: string): NonNullable<MetricsSample["memory"]> | null {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?/.exec(line);
    if (match) values.set(match[1]!, Number(match[2]) * (line.includes("kB") ? 1024 : 1));
  }
  const total = values.get("MemTotal");
  const available = values.get("MemAvailable");
  if (total === undefined || available === undefined) return null;
  return {
    totalBytes: total,
    availableBytes: available,
    freeBytes: values.get("MemFree") ?? 0,
    buffersBytes: values.get("Buffers") ?? 0,
    cachedBytes: (values.get("Cached") ?? 0) + (values.get("SReclaimable") ?? 0),
    swapTotalBytes: values.get("SwapTotal") ?? 0,
    swapFreeBytes: values.get("SwapFree") ?? 0,
  };
}

/** /proc/loadavg → [1, 5, 15] minute load averages. */
export function parseLoadavg(text: string): [number, number, number] | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const values = parts.slice(0, 3).map(Number);
  return values.every((v) => Number.isFinite(v) && v >= 0)
    ? (values as [number, number, number])
    : null;
}

/** /proc/uptime → seconds since boot. */
export function parseUptime(text: string): number | null {
  const value = Number(text.trim().split(/\s+/)[0]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** /proc/net/dev → cumulative per-interface counters. */
export function parseNetDev(
  text: string,
  isPhysical: (name: string) => boolean,
): NonNullable<MetricsSample["network"]> {
  const out: NonNullable<MetricsSample["network"]> = [];
  for (const line of text.split("\n").slice(2)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/);
    if (!name || fields.length < 16) continue;
    out.push({
      name,
      rxBytes: num(fields[0]),
      rxPackets: num(fields[1]),
      rxErrors: num(fields[2]),
      txBytes: num(fields[8]),
      txPackets: num(fields[9]),
      txErrors: num(fields[10]),
      physical: isPhysical(name),
    });
  }
  return out;
}

const SECTOR_BYTES = 512;

/**
 * /proc/diskstats → cumulative I/O per block device. `isDisk` decides which
 * names are whole disks (partitions, loop and ram devices are skipped so
 * traffic is not counted twice).
 */
export function parseDiskstats(
  text: string,
  isDisk: (name: string) => boolean,
): NonNullable<MetricsSample["disks"]> {
  const out: NonNullable<MetricsSample["disks"]> = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14) continue;
    const name = fields[2]!;
    if (!isDisk(name)) continue;
    out.push({
      name,
      readOps: num(fields[3]),
      readBytes: num(fields[5]) * SECTOR_BYTES,
      writeOps: num(fields[7]),
      writeBytes: num(fields[9]) * SECTOR_BYTES,
      busyMs: num(fields[12]),
    });
  }
  return out;
}

/** Heuristic used when /sys/block is unavailable. */
export function looksLikeWholeDisk(name: string): boolean {
  if (/^(loop|ram|zram|fd|sr)\d*/.test(name)) return false;
  if (/^(nvme\d+n\d+|mmcblk\d+)p\d+$/.test(name)) return false;
  if (/^(sd|vd|xvd|hd)[a-z]+\d+$/.test(name)) return false;
  return true;
}

export interface MountEntry {
  device: string;
  mountpoint: string;
  fsType: string;
  readOnly: boolean;
}

/** Octal escapes used in /proc/mounts (e.g. "\040" for a space). */
export function decodeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

/** Filesystems that hold user data; pseudo and in-memory filesystems are excluded. */
const DATA_FILESYSTEMS = new Set([
  "ext2",
  "ext3",
  "ext4",
  "xfs",
  "btrfs",
  "f2fs",
  "vfat",
  "exfat",
  "ntfs",
  "ntfs3",
  "zfs",
  "nfs",
  "nfs4",
  "cifs",
  "fuseblk",
  "apfs",
  "hfs",
]);

/** /proc/mounts → real (data) filesystems, first mount of each device only. */
export function parseMounts(text: string): MountEntry[] {
  const seen = new Set<string>();
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const [device, mountpoint, fsType, options] = line.trim().split(/\s+/);
    if (!device || !mountpoint || !fsType || !DATA_FILESYSTEMS.has(fsType)) continue;
    const decodedDevice = decodeMountField(device);
    if (seen.has(decodedDevice)) continue;
    seen.add(decodedDevice);
    out.push({
      device: decodedDevice,
      mountpoint: decodeMountField(mountpoint),
      fsType,
      readOnly: (options ?? "").split(",").includes("ro"),
    });
  }
  return out;
}

/** Little-endian hex IPv4 from /proc/net/route ("0101A8C0" → "192.168.1.1"). */
function hexToIpv4(hex: string): string | null {
  if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
  const value = Number.parseInt(hex, 16);
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255].join(".");
}

/** Default IPv4 gateways from /proc/net/route. */
export function parseIpv4Routes(text: string): Array<{ interface: string; address: string }> {
  const out: Array<{ interface: string; address: string }> = [];
  for (const line of text.split("\n").slice(1)) {
    const [iface, destination, gateway, flags] = line.trim().split(/\s+/);
    if (!iface || destination !== "00000000" || !gateway || !flags) continue;
    // RTF_UP (0x1) and RTF_GATEWAY (0x2) must both be set.
    if ((Number.parseInt(flags, 16) & 0x3) !== 0x3) continue;
    const address = hexToIpv4(gateway);
    if (address) out.push({ interface: iface, address });
  }
  return out;
}

/** RFC 5952 text form of eight hex groups (longest run of zero groups becomes "::"). */
export function compressIpv6(groups: string[]): string {
  const parts = groups.map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""));
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < parts.length;) {
    if (parts[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < parts.length && parts[j] === "0") j++;
    if (j - i > bestLength && j - i >= 2) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  if (bestStart < 0) return parts.join(":");
  const head = parts.slice(0, bestStart).join(":");
  const tail = parts.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

/** Default IPv6 gateways from /proc/net/ipv6_route. */
export function parseIpv6Routes(text: string): Array<{ interface: string; address: string }> {
  const out: Array<{ interface: string; address: string }> = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const [destination, prefix, , , nextHop, , , , flags, iface] = fields;
    if (
      destination !== "0".repeat(32) ||
      prefix !== "00" ||
      !nextHop ||
      nextHop === "0".repeat(32) ||
      !iface
    )
      continue;
    if ((Number.parseInt(flags ?? "0", 16) & 0x3) !== 0x3) continue;
    out.push({ interface: iface, address: compressIpv6(nextHop.match(/.{4}/g)!) });
  }
  return out;
}

/** Nameservers from /etc/resolv.conf. */
export function parseResolvConf(text: string): string[] {
  return text
    .split("\n")
    .map((line) => /^\s*nameserver\s+(\S+)/.exec(line)?.[1])
    .filter((value): value is string => Boolean(value))
    .slice(0, 16);
}
