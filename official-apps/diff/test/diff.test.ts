import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";
import {
  chunkAt,
  diffConfig,
  diffStats,
  ignoringWhitespace,
  lineEnding,
  patchName,
  unifiedPatch,
} from "../src/diff.ts";

const doc = (text: string) => Text.of(text.split("\n"));
const chunks = (a: string, b: string, ignoreWhitespace = false) =>
  Chunk.build(doc(a), doc(b), diffConfig(ignoreWhitespace));

describe("ignoring whitespace", () => {
  it("drops indentation, spacing and blank-line changes but keeps real ones", () => {
    expect(ignoringWhitespace("if (x) {\n  run();\n}", "if (x) {\n    run();\n}")).toEqual([]);
    expect(ignoringWhitespace("call(a,b)", "call(a, b)  ")).toEqual([]);
    expect(ignoringWhitespace("one\ntwo", "one\n\n\ntwo")).toEqual([]);
    const kept = ignoringWhitespace("  total = a + b;", "    total = a - b;");
    expect(kept).toHaveLength(1);
    expect("  total = a + b;".slice(kept[0]!.fromA, kept[0]!.toA)).toBe("+");
    expect("    total = a - b;".slice(kept[0]!.fromB, kept[0]!.toB)).toBe("-");
  });

  it("is what the merge view uses when the option is on", () => {
    const a = "function f() {\n\treturn 1;\n}\n";
    const b = "function f() {\n        return 1;\n}\n";
    expect(chunks(a, b)).toHaveLength(1);
    expect(chunks(a, b, true)).toHaveLength(0);
    expect(chunks(a, b.replace("1", "2"), true)).toHaveLength(1);
  });
});

describe("statistics and navigation", () => {
  it("counts changed regions and lines on each side", () => {
    const a = "one\ntwo\nthree\nfour";
    const b = "one\n2\nthree\nfour\nfive\nsix";
    const found = chunks(a, b);
    // Without a final line break, appending changes the last line too (as in git): the second
    // chunk replaces "four" with "four", "five", "six".
    expect(diffStats(found, doc(a), doc(b))).toEqual({ changes: 2, removed: 2, added: 4 });
    expect(chunkAt(found, "b", doc(b).line(2).from)).toBe(0);
    expect(chunkAt(found, "b", doc(b).line(3).from)).toBeNull();
    expect(chunkAt(found, "b", doc(b).line(6).from)).toBe(1);
    expect(chunkAt(found, "a", doc(a).line(2).from + 1)).toBe(0);
  });

  it("counts pure insertions and deletions", () => {
    const a = "a\nb\nc";
    const removed = chunks(a, "a\nc");
    expect(diffStats(removed, doc(a), doc("a\nc"))).toEqual({ changes: 1, removed: 1, added: 0 });
    const added = chunks(a, "a\nb\nx\ny\nc");
    expect(diffStats(added, doc(a), doc("a\nb\nx\ny\nc"))).toEqual({
      changes: 1,
      removed: 0,
      added: 2,
    });
  });
});

describe("line endings", () => {
  it("names the line endings of a text", () => {
    expect(lineEnding("a\nb\n")).toBe("LF");
    expect(lineEnding("a\r\nb\r\n")).toBe("CRLF");
    expect(lineEnding("a\rb")).toBe("CR");
    expect(lineEnding("a\r\nb\nc")).toBe("mixed");
    expect(lineEnding("single line")).toBeNull();
  });
});

describe("patches", () => {
  it("writes a unified patch that applies back exactly, whitespace included", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const a = `${lines.join("\n")}\n`;
    const changed = [...lines];
    changed[1] = "line two";
    changed[3] = "    line 4";
    const b = `${[...changed, "line 21"].join("\n")}\n`;
    const patch = await unifiedPatch(a, b, { a: "notes/list.txt", b: "list.txt" });
    expect(patch).toBe(
      [
        "--- a/list.txt",
        "+++ b/list.txt",
        "@@ -1,7 +1,7 @@",
        " line 1",
        "-line 2",
        "+line two",
        " line 3",
        "-line 4",
        "+    line 4",
        " line 5",
        " line 6",
        " line 7",
        "@@ -18,3 +18,4 @@",
        " line 18",
        " line 19",
        " line 20",
        "+line 21",
        "",
      ].join("\n"),
    );
    expect(applyPatch(a, patch!)).toBe(b);
  });

  it("marks a missing final newline", async () => {
    const patch = await unifiedPatch("a\nb", "a\nc", { a: "x", b: "x" });
    expect(patch).toContain("-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n");
  });

  it("gives up on texts too different to finish in time", async () => {
    const random = (seed: number) => {
      let state = seed;
      return Array.from({ length: 20_000 }, () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state.toString(36);
      }).join("\n");
    };
    expect(await unifiedPatch(random(1), random(2), { a: "a", b: "b" }, 1)).toBeNull();
  });

  it("keeps file names safe in headers", () => {
    expect(patchName("src/app/main.ts")).toBe("main.ts");
    expect(patchName("C:\\work\\a b.txt")).toBe("a b.txt");
    expect(patchName("tab\there")).toBe("tab here");
    expect(patchName("")).toBe("file");
  });
});
