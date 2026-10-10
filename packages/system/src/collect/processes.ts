import type { ProcessList } from "@otuken/shared";
import { findExecutable, runCommand } from "../exec.ts";
import { listDirOrEmpty, mapLimit, readBytesOrNull, readTextOrNull } from "../fs-utils.ts";
import { hostPath, REAL_HOST, type HostPaths } from "../host-paths.ts";
import { parseProcStat } from "../linux/procfs.ts";
import {
  CLOCK_TICKS_PER_SECOND,
  parseCmdline,
  parsePasswd,
  parsePidStat,
  parsePidStatus,
  type PidStat,
} from "../linux/proc-pid.ts";

const SAMPLE_INTERVAL_MS = 500;
/** Concurrent /proc reads; enough to stay fast without a burst of open files. */
const READ_CONCURRENCY = 16;

async function readAllStats(paths: HostPaths): Promise<Map<number, PidStat>> {
  const base = hostPath(paths, "/proc");
  const pids = (await listDirOrEmpty(base)).filter((name) => /^\d+$/.test(name)).slice(0, 32_768);
  const stats = new Map<number, PidStat>();
  await mapLimit(pids, READ_CONCURRENCY, async (pid) => {
    const text = await readTextOrNull(`${base}/${pid}/stat`, 4096);
    const parsed = text ? parsePidStat(text) : null;
    if (parsed) stats.set(parsed.pid, parsed);
  });
  return stats;
}

async function linuxProcesses(
  paths: HostPaths,
  sort: "cpu" | "memory",
  limit: number,
  now: () => number,
): Promise<ProcessList> {
  const before = await readAllStats(paths);
  await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS));
  const after = await readAllStats(paths);
  const elapsedTicks = (SAMPLE_INTERVAL_MS / 1000) * CLOCK_TICKS_PER_SECOND;
  const base = hostPath(paths, "/proc");
  const bootTime =
    parseProcStat((await readTextOrNull(`${base}/stat`, 256 * 1024)) ?? "")?.bootTime ?? null;

  const rows = await mapLimit([...after.values()], READ_CONCURRENCY, async (stat) => {
    const previous = before.get(stat.pid);
    const cpuPercent = previous
      ? Math.max(0, ((stat.cpuTicks - previous.cpuTicks) / elapsedTicks) * 100)
      : 0;
    const status = parsePidStatus((await readTextOrNull(`${base}/${stat.pid}/status`, 8192)) ?? "");
    return { stat, cpuPercent, ...status };
  });
  rows.sort((a, b) =>
    sort === "cpu"
      ? b.cpuPercent - a.cpuPercent || b.rssBytes - a.rssBytes
      : b.rssBytes - a.rssBytes,
  );
  const users = parsePasswd(
    (await readTextOrNull(hostPath(paths, "/etc/passwd"), 512 * 1024)) ?? "",
  );
  const top = rows.slice(0, limit);
  const processes = await mapLimit(
    top,
    READ_CONCURRENCY,
    async ({ stat, cpuPercent, uid, rssBytes }) => {
      // null: the process exited between samples.
      const cmdline = await readBytesOrNull(`${base}/${stat.pid}/cmdline`, 4096);
      const command = (cmdline ? parseCmdline(cmdline) : "") || `[${stat.comm}]`;
      return {
        pid: stat.pid,
        name: stat.comm,
        user: uid === null ? null : (users.get(uid) ?? String(uid)),
        state: stat.state.slice(0, 4),
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        memoryBytes: rssBytes,
        threads: stat.threads,
        command,
        startedAt:
          bootTime === null
            ? null
            : Math.round(bootTime + (stat.startTicks / CLOCK_TICKS_PER_SECOND) * 1000),
      };
    },
  );
  return { source: "host", sampledAt: now(), total: after.size, processes };
}

/** macOS/BSD development fallback using `ps` (real values, fewer fields). */
async function psProcesses(
  sort: "cpu" | "memory",
  limit: number,
  now: () => number,
): Promise<ProcessList> {
  const ps = await findExecutable("ps");
  if (!ps) return { source: "host", sampledAt: now(), total: 0, processes: [] };
  const output = await runCommand(ps, ["-A", "-o", "pid=,pcpu=,rss=,user=,state=,comm="], {
    timeoutMs: 5_000,
  });
  const rows = output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 6 && /^\d+$/.test(parts[0]!))
    .map((parts) => {
      const command = parts.slice(5).join(" ").slice(0, 512);
      return {
        pid: Number(parts[0]),
        name: (command.split("/").at(-1) ?? command).slice(0, 64),
        user: parts[3]!.slice(0, 64),
        state: parts[4]!.slice(0, 4),
        cpuPercent: Number(parts[1]) || 0,
        memoryBytes: (Number(parts[2]) || 0) * 1024,
        threads: 0,
        command,
        startedAt: null,
      };
    });
  rows.sort((a, b) =>
    sort === "cpu" ? b.cpuPercent - a.cpuPercent : b.memoryBytes - a.memoryBytes,
  );
  return { source: "host", sampledAt: now(), total: rows.length, processes: rows.slice(0, limit) };
}

/** Top processes by CPU (sampled over 0.5 s) or by resident memory. */
export async function collectProcesses(options: {
  paths?: HostPaths;
  sort: "cpu" | "memory";
  limit: number;
  now?: () => number;
}): Promise<ProcessList> {
  const paths = options.paths ?? REAL_HOST;
  const now = options.now ?? Date.now;
  const limit = Math.min(500, Math.max(1, options.limit));
  return paths.platform === "linux"
    ? linuxProcesses(paths, options.sort, limit, now)
    : psProcesses(options.sort, limit, now);
}
