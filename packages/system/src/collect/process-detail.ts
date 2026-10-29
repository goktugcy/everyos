import { readlink } from "node:fs/promises";
import { UNIT_NAME_PATTERN, type ProcessDetail } from "@everyos/shared";
import { findExecutable, runCommand } from "../exec.ts";
import { readBytesOrNull, readTextOrNull } from "../fs-utils.ts";
import { hostPath, REAL_HOST, type HostPaths } from "../host-paths.ts";
import {
  CLOCK_TICKS_PER_SECOND,
  parseCmdline,
  parsePasswd,
  parsePidStat,
  parsePidStatus,
} from "../linux/proc-pid.ts";
import { parseProcStat } from "../linux/procfs.ts";

/** A container takes precedence over its host runtime's systemd unit. */
export function processSupervisor(
  cgroup: string,
): Pick<ProcessDetail, "serviceUnit" | "containerId"> {
  const containerId =
    /(?:\/docker\/|\/docker-)([a-f0-9]{64})(?:\.scope|\/|$)/m.exec(cgroup)?.[1] ?? null;
  const systemPath = cgroup
    .split("\n")
    .map((line) => line.split(":").slice(2).join(":"))
    .find((path) => path.startsWith("/system.slice/") && !path.split("/").includes(".."));
  const serviceUnit =
    systemPath
      ?.split("/")
      .find(
        (part) => part.endsWith(".service") && UNIT_NAME_PATTERN.test(part) && !part.includes(".."),
      ) ?? null;
  return { containerId, serviceUnit: containerId ? null : serviceUnit };
}

async function link(path: string): Promise<string | null> {
  try {
    return (await readlink(path)).slice(0, 4096);
  } catch {
    return null;
  }
}

/** Reads one process, including processes outside the top-N list; never reads its environment. */
export async function collectProcessDetail(
  pid: number,
  options: { paths?: HostPaths; now?: () => number } = {},
): Promise<ProcessDetail | null> {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) return null;
  const paths = options.paths ?? REAL_HOST;
  const now = options.now ?? Date.now;
  if (paths.platform !== "linux") return psDetail(pid, now);
  const base = hostPath(paths, `/proc/${pid}`);
  const first = parsePidStat((await readTextOrNull(`${base}/stat`, 4096)) ?? "");
  if (!first || first.pid !== pid) return null;
  const start = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const [statText, statusText, cmdline, executable, workingDirectory, cgroup, passwd, procStat] =
    await Promise.all([
      readTextOrNull(`${base}/stat`, 4096),
      readTextOrNull(`${base}/status`, 8192),
      readBytesOrNull(`${base}/cmdline`, 4096),
      link(`${base}/exe`),
      link(`${base}/cwd`),
      readTextOrNull(`${base}/cgroup`, 16_384),
      readTextOrNull(hostPath(paths, "/etc/passwd"), 512 * 1024),
      readTextOrNull(hostPath(paths, "/proc/stat"), 256 * 1024),
    ]);
  const stat = parsePidStat(statText ?? "");
  if (!stat || stat.pid !== pid || stat.startTicks !== first.startTicks) return null;
  const status = parsePidStatus(statusText ?? "");
  const users = parsePasswd(passwd ?? "");
  const boot = parseProcStat(procStat ?? "")?.bootTime ?? null;
  const parent = /^PPid:\s+(\d+)/m.exec(statusText ?? "");
  const virtual = /^VmSize:\s+(\d+)\s+kB/m.exec(statusText ?? "");
  // Check again after reading links and cgroups: never attach one PID's old metadata to its reuse.
  const final = parsePidStat((await readTextOrNull(`${base}/stat`, 4096)) ?? "");
  if (!final || final.startTicks !== first.startTicks) return null;
  return {
    source: "host",
    sampledAt: now(),
    pid,
    name: stat.comm,
    user: status.uid === null ? null : (users.get(status.uid) ?? String(status.uid)),
    state: stat.state.slice(0, 4),
    cpuPercent: Math.max(
      0,
      ((stat.cpuTicks - first.cpuTicks) /
        (((performance.now() - start) / 1000) * CLOCK_TICKS_PER_SECOND)) *
        100,
    ),
    memoryBytes: status.rssBytes,
    threads: stat.threads,
    command: ((cmdline ? parseCmdline(cmdline) : "") || `[${stat.comm}]`).slice(0, 512),
    startedAt:
      boot === null ? null : Math.round(boot + (stat.startTicks / CLOCK_TICKS_PER_SECOND) * 1000),
    parentPid: parent ? Number(parent[1]) : null,
    virtualMemoryBytes: virtual ? Number(virtual[1]) * 1024 : null,
    executable,
    workingDirectory,
    ...processSupervisor(cgroup ?? ""),
  };
}

/** Development fallback: ps provides real values; unavailable fields remain null. */
async function psDetail(pid: number, now: () => number): Promise<ProcessDetail | null> {
  const ps = await findExecutable("ps");
  if (!ps) return null;
  let output: string;
  try {
    output = await runCommand(
      ps,
      ["-p", String(pid), "-o", "pid=,ppid=,pcpu=,rss=,vsz=,user=,state=,comm="],
      { timeoutMs: 5000 },
    );
  } catch {
    return null;
  }
  const parts = output.trim().split(/\s+/);
  if (parts.length < 8 || Number(parts[0]) !== pid) return null;
  const command = parts.slice(7).join(" ");
  return {
    source: "host",
    sampledAt: now(),
    pid,
    parentPid: Number(parts[1]),
    name: (command.split("/").at(-1) ?? command).slice(0, 64),
    user: parts[5]!.slice(0, 64),
    state: parts[6]!.slice(0, 4),
    cpuPercent: Number(parts[2]) || 0,
    memoryBytes: (Number(parts[3]) || 0) * 1024,
    virtualMemoryBytes: (Number(parts[4]) || 0) * 1024,
    threads: null,
    command: command.slice(0, 512),
    executable: command.slice(0, 4096),
    startedAt: null,
    workingDirectory: null,
    serviceUnit: null,
    containerId: null,
  };
}
