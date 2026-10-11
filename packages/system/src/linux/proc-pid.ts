/*
 * Per-process parsers for /proc/<pid>/stat, /proc/<pid>/status and
 * /proc/<pid>/cmdline, plus /etc/passwd for user names.
 */

export interface PidStat {
  pid: number;
  comm: string;
  state: string;
  /** utime + stime, clock ticks. */
  cpuTicks: number;
  threads: number;
  /** Start time after boot, clock ticks. */
  startTicks: number;
}

/** USER_HZ is 100 on every Linux architecture EveryOS targets (x86-64, arm64). */
export const CLOCK_TICKS_PER_SECOND = 100;

export function parsePidStat(text: string): PidStat | null {
  // comm is wrapped in parentheses and may itself contain spaces or ')'.
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const rest = text.slice(close + 2).split(" ");
  if (!Number.isInteger(pid) || rest.length < 20) return null;
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  return {
    pid,
    comm: text.slice(open + 1, close).slice(0, 64),
    state: rest[0] ?? "?",
    cpuTicks: (Number.isFinite(utime) ? utime : 0) + (Number.isFinite(stime) ? stime : 0),
    threads: Number(rest[17]) || 0,
    startTicks: Number(rest[19]) || 0,
  };
}

export function parsePidStatus(text: string): { uid: number | null; rssBytes: number } {
  const uid = /^Uid:\s+(\d+)/m.exec(text);
  const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(text);
  return { uid: uid ? Number(uid[1]) : null, rssBytes: rss ? Number(rss[1]) * 1024 : 0 };
}

/** NUL-separated argv → printable command line. */
export function parseCmdline(raw: Buffer | string): string {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  return (
    text
      .split("\0")
      .filter(Boolean)
      .join(" ")
      // eslint-disable-next-line no-control-regex -- strips control characters on purpose
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, 512)
  );
}

export function parsePasswd(text: string): Map<number, string> {
  const users = new Map<number, string>();
  for (const line of text.split("\n")) {
    const [name, , uid] = line.split(":");
    if (name && uid && /^\d+$/.test(uid)) users.set(Number(uid), name.slice(0, 64));
  }
  return users;
}
