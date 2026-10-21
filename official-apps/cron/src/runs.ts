import { CronExpressionParser } from "cron-parser";
import * as cronstrueModule from "cronstrue/i18n.js";

interface Describer {
  toString(expression: string, options: Record<string, unknown>): string;
}
// cronstrue is CommonJS marked as an ES module: depending on the loader (the bundle, or Node in
// tests) its class is the namespace's default or that default's own default.
const loaded = cronstrueModule as unknown as { default: Describer & { default?: Describer } };
const cronstrue: Describer = loaded.default.default ?? loaded.default;

/** cronstrue's names for EveryOS's languages. */
const CRONSTRUE_LOCALES: Record<string, string> = { zh: "zh_CN" };

/** The expression in words, in the person's language. */
export function describe(expression: string, locale: string): string {
  return cronstrue.toString(expression, {
    locale: CRONSTRUE_LOCALES[locale] ?? locale,
    use24HourTimeFormat: !locale.startsWith("en"),
    throwExceptionOnParseError: true,
    dayOfWeekStartIndexZero: true,
  });
}

/** The next (or previous) run times, as instants. */
export function runs(
  expression: string,
  timeZone: string,
  from: Date,
  count: number,
  direction: "next" | "prev" = "next",
): Date[] {
  let parsed: ReturnType<typeof CronExpressionParser.parse>;
  try {
    parsed = CronExpressionParser.parse(expression, { currentDate: from, tz: timeZone });
  } catch {
    // Dates that never exist (30 February): no runs.
    return [];
  }
  const out: Date[] = [];
  for (let index = 0; index < count; index += 1) {
    try {
      out.push((direction === "next" ? parsed.next() : parsed.prev()).toDate());
    } catch {
      break;
    }
  }
  return out;
}

export function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
