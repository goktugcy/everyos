/*
 * Cron expressions: parsing with precise errors, the visual builder's model, and conversions to
 * a systemd timer (OnCalendar) and to EveryOS's own Scheduled Tasks syntax. Next run times come
 * from cron-parser; this module decides what the expression means.
 */

export type FieldName = "second" | "minute" | "hour" | "day" | "month" | "weekday";

export const FIELD_LIMITS: Record<FieldName, { min: number; max: number }> = {
  second: { min: 0, max: 59 },
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  day: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  weekday: { min: 0, max: 7 },
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export type CronProblem =
  "field-count" | "empty" | "bad-token" | "out-of-range" | "bad-range" | "bad-step" | "reboot";

export class CronError extends Error {
  readonly problem: CronProblem;
  readonly field: FieldName | null;
  readonly token: string;

  constructor(problem: CronProblem, field: FieldName | null = null, token = "") {
    super(problem);
    this.name = "CronError";
    this.problem = problem;
    this.field = field;
    this.token = token;
  }
}

export interface ParsedField {
  name: FieldName;
  text: string;
  /** Every value the field allows (weekday 7 is folded into 0). */
  values: number[];
  /** "*" (or "?"): no restriction. */
  any: boolean;
}

export interface ParsedCron {
  /** With seconds: six fields. */
  seconds: boolean;
  fields: ParsedField[];
  /** The five or six fields the expression stands for (macros expanded). */
  normalized: string;
}

function number(text: string, name: FieldName): number {
  const upper = text.toUpperCase();
  if (name === "month" && MONTHS.includes(upper)) return MONTHS.indexOf(upper) + 1;
  if (name === "weekday" && WEEKDAYS.includes(upper)) return WEEKDAYS.indexOf(upper);
  if (!/^\d+$/.test(text)) throw new CronError("bad-token", name, text);
  return Number(text);
}

export function parseField(text: string, name: FieldName): ParsedField {
  const { min, max } = FIELD_LIMITS[name];
  if (!text) throw new CronError("empty", name);
  const values = new Set<number>();
  const any = text === "*" || text === "?";
  for (const part of text.split(",")) {
    if (!part) throw new CronError("bad-token", name, text);
    const [range = "", stepText] = part.split("/");
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1)
        throw new CronError("bad-step", name, part);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === "*" || range === "?") {
      from = min;
      to = name === "weekday" ? 6 : max;
    } else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      from = number(a, name);
      to = number(b, name);
      if (from > to) throw new CronError("bad-range", name, part);
    } else {
      from = number(range, name);
      // "5/15" is "5-max/15".
      to = stepText !== undefined ? (name === "weekday" ? 6 : max) : from;
    }
    for (const value of [from, to])
      if (value < min || value > max) throw new CronError("out-of-range", name, String(value));
    for (let value = from; value <= to; value += step)
      values.add(name === "weekday" && value === 7 ? 0 : value);
  }
  return { name, text, values: [...values].sort((a, b) => a - b), any };
}

export function parseCron(expression: string, allowSeconds = true): ParsedCron {
  const trimmed = expression.trim();
  if (trimmed.toLowerCase() === "@reboot") throw new CronError("reboot");
  const normalized = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (!(parts.length === 5 || (allowSeconds && parts.length === 6)))
    throw new CronError("field-count", null, String(parts.length));
  const seconds = parts.length === 6;
  const names: FieldName[] = seconds
    ? ["second", "minute", "hour", "day", "month", "weekday"]
    : ["minute", "hour", "day", "month", "weekday"];
  return {
    seconds,
    fields: parts.map((part, index) => parseField(part, names[index]!)),
    normalized: parts.join(" "),
  };
}

/* ------------------------------------------------------------------ the visual builder */

export type FieldMode =
  | { mode: "every" }
  | { mode: "specific"; values: number[] }
  | { mode: "range"; from: number; to: number }
  | { mode: "step"; start: number; every: number };

/** The builder's form of a field, or null when the field needs the expression itself. */
export function fieldMode(text: string, name: FieldName): FieldMode | null {
  const { min, max } = FIELD_LIMITS[name];
  if (text === "*" || text === "?") return { mode: "every" };
  if (/^\d+(,\d+)*$/.test(text)) return { mode: "specific", values: text.split(",").map(Number) };
  let match = /^(\d+)-(\d+)$/.exec(text);
  if (match) return { mode: "range", from: Number(match[1]), to: Number(match[2]) };
  match = /^\*\/(\d+)$/.exec(text);
  if (match) return { mode: "step", start: min, every: Number(match[1]) };
  match = /^(\d+)(?:-(\d+))?\/(\d+)$/.exec(text);
  if (match && (match[2] === undefined || Number(match[2]) === (name === "weekday" ? 6 : max)))
    return { mode: "step", start: Number(match[1]), every: Number(match[3]) };
  return null;
}

export function fieldText(mode: FieldMode, name: FieldName): string {
  const { min, max } = FIELD_LIMITS[name];
  switch (mode.mode) {
    case "every":
      return "*";
    case "specific":
      return mode.values.length
        ? [...new Set(mode.values)].sort((a, b) => a - b).join(",")
        : String(min);
    case "range":
      return `${mode.from}-${mode.to}`;
    case "step":
      return mode.start === min
        ? `*/${mode.every}`
        : `${mode.start}-${name === "weekday" ? 6 : max}/${mode.every}`;
  }
}

/* ------------------------------------------------------------------ systemd timers */

const SYSTEMD_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Values as systemd writes them: runs become ranges ("1..5"), the rest a list. */
function systemdValues(values: readonly number[], pad: number, name?: FieldName): string {
  const parts: string[] = [];
  const write = (value: number) =>
    name === "weekday" ? SYSTEMD_DAYS[value]! : String(value).padStart(pad, "0");
  for (let index = 0; index < values.length;) {
    let end = index;
    while (end + 1 < values.length && values[end + 1] === values[end]! + 1) end += 1;
    if (end - index >= 2) parts.push(`${write(values[index]!)}..${write(values[end]!)}`);
    else for (let i = index; i <= end; i += 1) parts.push(write(values[i]!));
    index = end + 1;
  }
  return parts.join(",");
}

function systemdField(field: ParsedField, pad: number): string {
  if (field.any) return "*";
  const { min, max } = FIELD_LIMITS[field.name];
  // A step over the whole field keeps its compact form: "0/15".
  const step = /^(\*|\d+)(?:-(\d+))?\/(\d+)$/.exec(field.text);
  if (step && field.name !== "weekday") {
    const start = step[1] === "*" ? min : Number(step[1]);
    const end = step[2] === undefined ? max : Number(step[2]);
    if (end === max) return `${String(start).padStart(pad, "0")}/${step[3]}`;
  }
  return systemdValues(field.values, pad, field.name);
}

/**
 * OnCalendar= lines with the same times. Cron runs when either day field matches if both are
 * restricted; systemd needs both, so that case becomes two lines (a timer accepts several).
 */
export function toOnCalendar(parsed: ParsedCron): string[] {
  const byName = Object.fromEntries(parsed.fields.map((field) => [field.name, field])) as Record<
    FieldName,
    ParsedField | undefined
  >;
  const second = byName.second ? systemdField(byName.second, 2) : "00";
  const time = `${systemdField(byName.hour!, 2)}:${systemdField(byName.minute!, 2)}:${second}`;
  const month = systemdField(byName.month!, 2);
  const day = byName.day!;
  const weekday = byName.weekday!;
  const line = (weekdays: string | null, days: string) =>
    `${weekdays ? `${weekdays} ` : ""}*-${month}-${days} ${time}`;
  const days = systemdField(day, 2);
  const weekdays = weekday.any ? null : systemdValues(weekday.values, 0, "weekday");
  if (!day.any && weekdays) return [line(null, days), line(weekdays, "*")];
  return [line(weekdays, days)];
}

/* ------------------------------------------------------------------ EveryOS Scheduled Tasks */

export type TaskProblem = "seconds" | "too-frequent";

/**
 * Whether EveryOS's Scheduled Tasks accept the expression (five numeric fields, at most twelve
 * runs an hour and at least five minutes apart), and the numeric form they need.
 */
export function forEveryOSTask(expression: string): {
  expression: string;
  problems: TaskProblem[];
} {
  const parsed = parseCron(expression);
  const problems: TaskProblem[] = [];
  if (parsed.seconds) problems.push("seconds");
  const minutes = parsed.fields.find((field) => field.name === "minute")!.values;
  const gaps = minutes.map((value, index) => (minutes[index + 1] ?? minutes[0]! + 60) - value);
  if (minutes.length > 12 || (minutes.length > 1 && Math.min(...gaps) < 5))
    problems.push("too-frequent");
  // Names and macros can be written as numbers; seconds and frequency cannot.
  const numeric = parsed.fields
    .filter((field) => field.name !== "second")
    .map((field) =>
      field.any
        ? "*"
        : /[a-z]/i.test(field.text)
          ? systemdValues(field.values, 0).replace(/\.\./g, "-")
          : field.text,
    )
    .join(" ");
  return { expression: numeric, problems };
}

export interface Preset {
  id: string;
  expression: string;
}

export const PRESETS: readonly Preset[] = [
  { id: "everyMinute", expression: "* * * * *" },
  { id: "every5Minutes", expression: "*/5 * * * *" },
  { id: "every15Minutes", expression: "*/15 * * * *" },
  { id: "hourly", expression: "0 * * * *" },
  { id: "every6Hours", expression: "0 */6 * * *" },
  { id: "daily3am", expression: "0 3 * * *" },
  { id: "weekdays9am", expression: "0 9 * * 1-5" },
  { id: "weeklySunday", expression: "0 0 * * 0" },
  { id: "monthlyFirst", expression: "0 0 1 * *" },
  { id: "quarterly", expression: "0 0 1 1,4,7,10 *" },
  { id: "yearly", expression: "0 0 1 1 *" },
];
