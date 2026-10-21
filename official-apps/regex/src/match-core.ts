import { groupNames } from "./explain.ts";

/*
 * Matching, as the worker runs it (and tests call it directly). The time limit is the worker's
 * job: a pattern that backtracks catastrophically cannot be interrupted from inside.
 */

export const LIMITS = {
  /** Characters of test text. */
  text: 1_000_000,
  /** Matches reported (the rest are counted as truncated). */
  matches: 10_000,
  /** Milliseconds before the worker is stopped. */
  timeoutMs: 1500,
};

export interface MatchRequest {
  pattern: string;
  flags: string;
  text: string;
  /** null: no replacement preview. */
  replacement: string | null;
}

export interface Group {
  /** 1-based number, and the name of named groups. */
  number: number;
  name: string | null;
  value: string | null;
  start: number | null;
  end: number | null;
}

export interface MatchInfo {
  index: number;
  end: number;
  text: string;
  groups: Group[];
}

export type MatchResult =
  | { ok: true; matches: MatchInfo[]; truncated: boolean; replaced: string | null; ms: number }
  | { ok: false; error: "syntax"; message: string }
  | { ok: false; error: "too-long" };

export function runMatch(
  request: MatchRequest,
  now: () => number = () => performance.now(),
): MatchResult {
  if (request.text.length > LIMITS.text) return { ok: false, error: "too-long" };
  let regex: RegExp;
  try {
    // "d" adds group positions; it does not change what matches.
    const flags = request.flags.includes("d") ? request.flags : `${request.flags}d`;
    regex = new RegExp(request.pattern, flags);
  } catch (error) {
    return {
      ok: false,
      error: "syntax",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const started = now();
  const names = groupNames(request.pattern);
  const matches: MatchInfo[] = [];
  let truncated = false;
  const record = (match: RegExpExecArray) => {
    if (matches.length >= LIMITS.matches) {
      truncated = true;
      return false;
    }
    const indices = (match as RegExpExecArray & { indices?: Array<[number, number] | undefined> })
      .indices;
    matches.push({
      index: match.index,
      end: match.index + match[0].length,
      text: match[0],
      groups: match.slice(1).map((value, offset) => {
        const range = indices?.[offset + 1];
        return {
          number: offset + 1,
          name: names.get(offset + 1) ?? null,
          value: value ?? null,
          start: range ? range[0] : null,
          end: range ? range[1] : null,
        };
      }),
    });
    return true;
  };
  if (regex.global || regex.sticky) {
    regex.lastIndex = 0;
    for (;;) {
      const match = regex.exec(request.text);
      if (!match || !record(match)) break;
      if (!regex.global && regex.sticky && match[0] === "") break;
      // Zero-length matches advance by one (a code point with the u or v flag).
      if (match[0] === "") {
        const code = request.text.codePointAt(regex.lastIndex) ?? 0;
        regex.lastIndex += (regex.unicode || regex.unicodeSets) && code > 0xffff ? 2 : 1;
      }
    }
  } else {
    const match = regex.exec(request.text);
    if (match) record(match);
  }
  let replaced: string | null = null;
  if (request.replacement !== null) {
    regex.lastIndex = 0;
    replaced = request.text.replace(regex, request.replacement);
  }
  return { ok: true, matches, truncated, replaced, ms: Math.round((now() - started) * 10) / 10 };
}
