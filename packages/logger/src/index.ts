import { inspect } from "node:util";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LogSink {
  write(line: string): unknown;
}

export interface LoggerOptions {
  name: string;
  level?: LogLevel;
  format?: "json" | "pretty";
  sink?: LogSink;
  /**
   * Prefix JSON lines with a syslog priority (`<3>`) so journald records the
   * correct severity. Defaults to true when stdout is connected to journald.
   */
  syslogPrefix?: boolean;
  /** Extra key patterns whose values must never be written to logs. */
  redact?: readonly RegExp[];
  now?: () => Date;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

// RFC 5424 severities used by journald's SyslogLevelPrefix parsing.
const SYSLOG_PRIORITY: Record<Exclude<LogLevel, "silent">, number> = {
  trace: 7,
  debug: 7,
  info: 6,
  warn: 4,
  error: 3,
  fatal: 2,
};

const DEFAULT_REDACT: readonly RegExp[] = [
  /pass(word)?/i,
  /secret/i,
  /token/i,
  /cookie/i,
  /authorization/i,
  /totp/i,
  /recovery/i,
  /^key$/i,
  /hmac/i,
];

const MAX_DEPTH = 6;
const REDACTED = "[redacted]";

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

export function serializeError(error: unknown): LogFields {
  if (error instanceof Error) {
    const out: LogFields = { name: error.name, message: error.message };
    if (error.stack) out.stack = error.stack;
    const code = (error as { code?: unknown }).code;
    if (code !== undefined) out.code = code;
    if (error.cause !== undefined) out.cause = serializeError(error.cause);
    return out;
  }
  return { value: typeof error === "string" ? error : inspect(error, { depth: 2 }) };
}

function sanitize(
  value: unknown,
  redact: readonly RegExp[],
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
    return value;
  }
  if (value instanceof Error) return sanitize(serializeError(value), redact, depth, seen);
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, redact, depth + 1, seen));
  }
  const out: LogFields = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redact.some((pattern) => pattern.test(key))
      ? REDACTED
      : sanitize(item, redact, depth + 1, seen);
  }
  return out;
}

const ANSI: Record<Exclude<LogLevel, "silent">, string> = {
  trace: "\u001b[90m",
  debug: "\u001b[36m",
  info: "\u001b[32m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
  fatal: "\u001b[35m",
};

function formatPretty(
  record: LogFields,
  level: Exclude<LogLevel, "silent">,
  color: boolean,
): string {
  const { time, msg, name, level: _level, ...rest } = record;
  const clock = typeof time === "string" ? time.slice(11, 23) : "";
  const tag = level.toUpperCase().padEnd(5);
  const label = color ? `${ANSI[level]}${tag}\u001b[0m` : tag;
  const extras =
    Object.keys(rest).length > 0
      ? ` ${inspect(rest, { colors: color, depth: 4, breakLength: Infinity })}`
      : "";
  return `${clock} ${label} [${String(name)}] ${String(msg)}${extras}\n`;
}

class StructuredLogger implements Logger {
  readonly level: LogLevel;
  readonly #options: Required<Omit<LoggerOptions, "level">>;
  readonly #bindings: LogFields;
  readonly #threshold: number;
  readonly #color: boolean;

  constructor(
    options: Required<Omit<LoggerOptions, "level">> & { level: LogLevel },
    bindings: LogFields,
  ) {
    this.level = options.level;
    this.#options = options;
    this.#bindings = bindings;
    this.#threshold = LEVEL_WEIGHT[options.level];
    this.#color = options.format === "pretty" && process.stdout.isTTY && !process.env.NO_COLOR;
  }

  trace(msg: string, fields?: LogFields): void {
    this.#log("trace", msg, fields);
  }
  debug(msg: string, fields?: LogFields): void {
    this.#log("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.#log("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.#log("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.#log("error", msg, fields);
  }
  fatal(msg: string, fields?: LogFields): void {
    this.#log("fatal", msg, fields);
  }

  child(bindings: LogFields): Logger {
    return new StructuredLogger(
      { ...this.#options, level: this.level },
      { ...this.#bindings, ...bindings },
    );
  }

  #log(level: Exclude<LogLevel, "silent">, msg: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < this.#threshold) return;
    const record = sanitize(
      {
        time: this.#options.now().toISOString(),
        level,
        name: this.#options.name,
        msg,
        ...this.#bindings,
        ...fields,
      },
      this.#options.redact,
      0,
      new WeakSet(),
    ) as LogFields;
    try {
      if (this.#options.format === "pretty") {
        this.#options.sink.write(formatPretty(record, level, this.#color));
      } else {
        const prefix = this.#options.syslogPrefix ? `<${SYSLOG_PRIORITY[level]}>` : "";
        this.#options.sink.write(`${prefix}${JSON.stringify(record)}\n`);
      }
    } catch {
      // Logging must never crash the process.
    }
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new StructuredLogger(
    {
      name: options.name,
      level: options.level ?? "info",
      format: options.format ?? "json",
      sink: options.sink ?? process.stdout,
      syslogPrefix: options.syslogPrefix ?? Boolean(process.env.JOURNAL_STREAM),
      redact: [...DEFAULT_REDACT, ...(options.redact ?? [])],
      now: options.now ?? (() => new Date()),
    },
    {},
  );
}

/** A logger that discards everything; useful for tests. */
export const silentLogger: Logger = createLogger({ name: "silent", level: "silent" });
