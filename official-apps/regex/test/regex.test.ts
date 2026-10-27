import { describe, expect, it, vi } from "vitest";
import { EXAMPLES } from "../src/examples.ts";
import { explain, groupNames } from "../src/explain.ts";
import { LIMITS, runMatch, type MatchRequest } from "../src/match-core.ts";
import { createMatcher, type WorkerLike } from "../src/matcher.ts";

const run = (pattern: string, flags: string, text: string, replacement: string | null = null) =>
  runMatch({ pattern, flags, text, replacement });

describe("matching", () => {
  it("finds matches, numbered and named groups with their positions", () => {
    const result = run(String.raw`(?<user>\w+)@(\w+)\.com`, "g", "ada@example.com, grace@navy.com");
    expect(result.ok && result.matches.map((match) => match.text)).toEqual([
      "ada@example.com",
      "grace@navy.com",
    ]);
    if (!result.ok) throw new Error();
    expect(result.matches[1]!.groups).toEqual([
      { number: 1, name: "user", value: "grace", start: 17, end: 22 },
      { number: 2, name: null, value: "navy", start: 23, end: 27 },
    ]);
  });

  it("reports optional groups that did not take part, and one match without g", () => {
    const result = run("a(b)?c", "", "ac abc");
    if (!result.ok) throw new Error();
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.groups[0]).toMatchObject({ value: null, start: null });
  });

  it("steps over empty matches, by code point with u", () => {
    const plain = run("x*", "g", "ab");
    expect(plain.ok && plain.matches.map((match) => match.index)).toEqual([0, 1, 2]);
    const unicode = run("", "gu", "😀a");
    expect(unicode.ok && unicode.matches.map((match) => match.index)).toEqual([0, 2, 3]);
  });

  it("previews replacements with $1, $<name>, $& and $$", () => {
    const result = run(String.raw`(?<w>\w+)@(\w+)`, "g", "a@b c@d", "[$<w> at $2 / $& / $$]");
    expect(result.ok && result.replaced).toBe("[a at b / a@b / $] [c at d / c@d / $]");
  });

  it("explains syntax errors and respects the limits", () => {
    expect(run("(", "", "x")).toMatchObject({ ok: false, error: "syntax" });
    expect(run("a", "", "x".repeat(LIMITS.text + 1))).toEqual({ ok: false, error: "too-long" });
    const many = run("a", "g", "a".repeat(LIMITS.matches + 5));
    expect(many.ok && many.matches.length).toBe(LIMITS.matches);
    expect(many.ok && many.truncated).toBe(true);
  });

  it("every example compiles and matches its sample text", () => {
    for (const example of EXAMPLES) {
      const result = run(example.pattern, example.flags, example.text);
      expect(result.ok, example.id).toBe(true);
      expect(result.ok && result.matches.length, example.id).toBeGreaterThan(0);
    }
  });
});

describe("explanations", () => {
  const keys = (pattern: string) => explain(pattern).map((part) => part.key);
  it("names every construct with its place and depth", () => {
    expect(keys(String.raw`^\d{3,}-?(?<area>[A-Z]+|\w*?)\b$`)).toEqual([
      "start",
      "digit",
      "atLeast",
      "literal",
      "optional",
      "namedGroup",
      "class",
      "oneOrMore",
      "alternation",
      "word",
      "zeroOrMoreLazy",
      "groupEnd",
      "wordBoundary",
      "end",
    ]);
    const parts = explain("(a(?:b))");
    expect(parts.map((part) => part.depth)).toEqual([0, 1, 1, 2, 1, 0]);
    expect(explain("x{2,5}")[1]).toMatchObject({ key: "between", values: { min: 2, max: 5 } });
    expect(explain(String.raw`\p{L}\P{N}`).map((part) => part.values?.name)).toEqual(["L", "N"]);
    expect(keys(String.raw`(?=a)(?!b)(?<=c)(?<!d)\1\k<x>[^0-9].\u{1F600}`)).toEqual([
      "lookahead",
      "literal",
      "groupEnd",
      "negativeLookahead",
      "literal",
      "groupEnd",
      "lookbehind",
      "literal",
      "groupEnd",
      "negativeLookbehind",
      "literal",
      "groupEnd",
      "backreference",
      "namedBackreference",
      "notClass",
      "any",
      "unicode",
    ]);
    expect(explain("hello")[0]).toMatchObject({ key: "literals", values: { char: "hello" } });
  });

  it("numbers named groups as matches do", () => {
    expect([...groupNames(String.raw`(a)(?<x>b)(?:c)(?<y>d)[(]`)]).toEqual([
      [2, "x"],
      [3, "y"],
    ]);
  });
});

describe("the time limit", () => {
  function fakeWorker(delayMs: number) {
    const workers: Array<WorkerLike & { terminated: boolean }> = [];
    const start = () => {
      const worker: WorkerLike & { terminated: boolean } = {
        terminated: false,
        onmessage: null,
        onerror: null,
        postMessage(message: unknown) {
          const { id, request } = message as { id: number; request: MatchRequest };
          setTimeout(() => {
            if (!worker.terminated)
              worker.onmessage?.({ data: { id, result: runMatch(request) } } as MessageEvent);
          }, delayMs);
        },
        terminate() {
          worker.terminated = true;
        },
      };
      workers.push(worker);
      return Promise.resolve(worker);
    };
    return { start, workers };
  }

  it("stops a run that takes too long and starts a fresh worker next time", async () => {
    vi.useFakeTimers();
    try {
      const slow = fakeWorker(5000);
      const matcher = createMatcher(slow.start, 1500);
      const pending = matcher.run({ pattern: "a", flags: "g", text: "aaa", replacement: null });
      await vi.advanceTimersByTimeAsync(1600);
      await expect(pending).resolves.toEqual({ ok: false, error: "timeout" });
      expect(slow.workers[0]!.terminated).toBe(true);
      const next = matcher.run({ pattern: "a", flags: "g", text: "aaa", replacement: null });
      await vi.advanceTimersByTimeAsync(1600);
      await next;
      expect(slow.workers).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers quick runs from the same worker", async () => {
    const fast = fakeWorker(0);
    const matcher = createMatcher(fast.start, 1500);
    const first = await matcher.run({ pattern: "b", flags: "g", text: "abcb", replacement: null });
    const second = await matcher.run({ pattern: "c", flags: "", text: "abcb", replacement: null });
    expect(first.ok && first.matches.length).toBe(2);
    expect(second.ok && second.matches.length).toBe(1);
    expect(fast.workers).toHaveLength(1);
  });
});
