import type { LogEntry } from "@everyos/shared";

const MAX_MESSAGE = 16_384;

/** Removes terminal control sequences and non-printable characters (keeps tab and newline). */
export function sanitizeLogText(text: string): string {
  return (
    text
      // Matching control characters is the point of these two expressions.
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .slice(0, MAX_MESSAGE)
  );
}

function field(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string") return value;
  // journald emits non-UTF-8 or binary fields as arrays of byte values.
  if (Array.isArray(value) && value.every((b) => typeof b === "number")) {
    return Buffer.from(value).toString("utf8");
  }
  return null;
}

/** One line of `journalctl --output=json` → a log entry, or null if unusable. */
export function parseJournalLine(line: string): LogEntry | null {
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    record = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const cursor = field(record, "__CURSOR");
  const realtime = Number(field(record, "__REALTIME_TIMESTAMP"));
  if (!cursor || !Number.isFinite(realtime)) return null;
  const priority = Number(field(record, "PRIORITY") ?? 6);
  const pid = Number(field(record, "_PID"));
  const unit = field(record, "_SYSTEMD_UNIT") ?? field(record, "UNIT");
  return {
    cursor: cursor.slice(0, 512),
    ts: Math.floor(realtime / 1000),
    priority: Number.isInteger(priority) && priority >= 0 && priority <= 7 ? priority : 6,
    unit: unit ? unit.slice(0, 256) : null,
    identifier:
      (field(record, "SYSLOG_IDENTIFIER") ?? field(record, "_COMM"))?.slice(0, 128) ?? null,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    hostname: field(record, "_HOSTNAME")?.slice(0, 256) ?? null,
    message: sanitizeLogText(field(record, "MESSAGE") ?? ""),
  };
}
