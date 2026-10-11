import type { CpuTimes, MetricsPoint, MetricsSample, MetricsSnapshot } from "@everyos/shared";

/*
 * Turns raw cumulative counters (as sampled by the agent) into rates.
 * Counters can reset (reboot, interface re-created, 32-bit wrap); a negative
 * delta yields `null` for that value rather than a fabricated number.
 */

function cpuBusyPercent(previous: CpuTimes, current: CpuTimes): number | null {
  const total = (t: CpuTimes) =>
    t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal;
  const totalDelta = total(current) - total(previous);
  const idleDelta = current.idle + current.iowait - (previous.idle + previous.iowait);
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) return null;
  return round(((totalDelta - idleDelta) / totalDelta) * 100, 1);
}

function rate(previous: number, current: number, seconds: number): number | null {
  const delta = current - previous;
  return delta < 0 ? null : delta / seconds;
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function preferredTemperature(sample: MetricsSample): number | null {
  if (!sample.thermal || sample.thermal.length === 0) return null;
  const cpu = sample.thermal.find((zone) => /cpu|soc|x86_pkg/i.test(zone.type));
  return cpu?.celsius ?? Math.max(...sample.thermal.map((zone) => zone.celsius));
}

function sumRates<T extends { name: string }>(
  previous: readonly T[] | null,
  current: readonly T[] | null,
  seconds: number,
  pick: (item: T) => number,
  include: (item: T) => boolean = () => true,
): number | null {
  if (!previous || !current) return null;
  const before = new Map(previous.map((item) => [item.name, item]));
  let total = 0;
  for (const item of current) {
    if (!include(item)) continue;
    const old = before.get(item.name);
    if (!old) continue;
    const value = rate(pick(old), pick(item), seconds);
    if (value === null) return null;
    total += value;
  }
  return round(total);
}

/** Values that only need one sample. */
function instantPoint(sample: MetricsSample): MetricsPoint {
  const memory = sample.memory;
  return {
    at: sample.at,
    cpuPercent: null,
    memoryUsedBytes: memory ? memory.totalBytes - memory.availableBytes : null,
    memoryTotalBytes: memory?.totalBytes ?? null,
    swapUsedBytes: memory ? memory.swapTotalBytes - memory.swapFreeBytes : null,
    swapTotalBytes: memory ? memory.swapTotalBytes : null,
    load1: sample.load?.[0] ?? null,
    netRxBytesPerSec: null,
    netTxBytesPerSec: null,
    diskReadBytesPerSec: null,
    diskWriteBytesPerSec: null,
    temperatureC: preferredTemperature(sample),
  };
}

/*
 * Host network totals count physical interfaces only: bridges, veth pairs,
 * tunnels and Tailscale carry traffic that also crosses a physical NIC, so
 * including them would count the same bytes twice.
 */
export function computePoint(previous: MetricsSample | null, current: MetricsSample): MetricsPoint {
  const point = instantPoint(current);
  const seconds = previous ? (current.at - previous.at) / 1000 : 0;
  if (!previous || seconds <= 0) return point;
  return {
    ...point,
    cpuPercent:
      previous.cpu && current.cpu ? cpuBusyPercent(previous.cpu.total, current.cpu.total) : null,
    netRxBytesPerSec: sumRates(
      previous.network,
      current.network,
      seconds,
      (i) => i.rxBytes,
      (nic) => nic.physical,
    ),
    netTxBytesPerSec: sumRates(
      previous.network,
      current.network,
      seconds,
      (i) => i.txBytes,
      (nic) => nic.physical,
    ),
    diskReadBytesPerSec: sumRates(previous.disks, current.disks, seconds, (d) => d.readBytes),
    diskWriteBytesPerSec: sumRates(previous.disks, current.disks, seconds, (d) => d.writeBytes),
  };
}

export function computeSnapshot(
  previous: MetricsSample | null,
  current: MetricsSample,
): MetricsSnapshot {
  const seconds = previous ? (current.at - previous.at) / 1000 : 0;
  const usable = previous !== null && seconds > 0;
  const before = <T extends { name: string }>(items: readonly T[] | null | undefined) =>
    new Map((items ?? []).map((item) => [item.name, item]));
  const oldNet = before(previous?.network);
  const oldDisks = before(previous?.disks);

  return {
    source: current.source,
    point: computePoint(previous, current),
    uptimeSeconds: current.uptimeSeconds,
    load: current.load,
    cpuCores:
      usable &&
      previous.cpu &&
      current.cpu &&
      previous.cpu.cores.length === current.cpu.cores.length
        ? current.cpu.cores.map(
            (core, index) => cpuBusyPercent(previous.cpu!.cores[index]!, core) ?? 0,
          )
        : null,
    cpuFrequencyMHz: current.cpuFrequencyMHz,
    interfaces:
      usable && current.network
        ? current.network.flatMap((nic) => {
            const old = oldNet.get(nic.name);
            const rx = old ? rate(old.rxBytes, nic.rxBytes, seconds) : null;
            const tx = old ? rate(old.txBytes, nic.txBytes, seconds) : null;
            return rx === null || tx === null
              ? []
              : [{ name: nic.name, rxBytesPerSec: round(rx), txBytesPerSec: round(tx) }];
          })
        : null,
    disks:
      usable && current.disks
        ? current.disks.flatMap((disk) => {
            const old = oldDisks.get(disk.name);
            if (!old) return [];
            const read = rate(old.readBytes, disk.readBytes, seconds);
            const write = rate(old.writeBytes, disk.writeBytes, seconds);
            const busy = rate(old.busyMs, disk.busyMs, seconds);
            if (read === null || write === null || busy === null) return [];
            return [
              {
                name: disk.name,
                readBytesPerSec: round(read),
                writeBytesPerSec: round(write),
                busyPercent: Math.min(100, round(busy / 10, 1)),
              },
            ];
          })
        : null,
    thermal: current.thermal,
    fans: current.fans,
  };
}

/** Averages points into fixed buckets (for long ranges); nulls are ignored per field. */
export function downsample(points: readonly MetricsPoint[], bucketMs: number): MetricsPoint[] {
  const buckets = new Map<number, MetricsPoint[]>();
  for (const point of points) {
    const key = Math.floor(point.at / bucketMs) * bucketMs;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(point);
    else buckets.set(key, [point]);
  }
  const fields = [
    "cpuPercent",
    "memoryUsedBytes",
    "memoryTotalBytes",
    "swapUsedBytes",
    "swapTotalBytes",
    "load1",
    "netRxBytesPerSec",
    "netTxBytesPerSec",
    "diskReadBytesPerSec",
    "diskWriteBytesPerSec",
    "temperatureC",
  ] as const;
  return [...buckets].map(([at, group]) => {
    const point: MetricsPoint = { ...group[group.length - 1]!, at };
    for (const field of fields) {
      const values = group.map((p) => p[field]).filter((v): v is number => v !== null);
      point[field] =
        values.length === 0 ? null : round(values.reduce((a, b) => a + b, 0) / values.length, 2);
    }
    return point;
  });
}
