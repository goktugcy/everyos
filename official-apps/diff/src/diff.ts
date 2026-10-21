import { presentableDiff, type Change, type Chunk, type DiffConfig } from "@codemirror/merge";
import type { Text } from "@codemirror/state";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";

/**
 * Limits for the character diff: past them the merge view falls back to a faster, coarser diff
 * (its chunks are then marked imprecise) instead of freezing on large, very different texts.
 */
export const DIFF_LIMITS = { scanLimit: 5000, timeout: 1500 } as const;

const visible = (text: string) => text.replace(/\s+/g, "");

/**
 * The diff without changes that only add, remove or move whitespace (indentation, spacing, blank
 * lines, line breaks): a change is dropped when both sides read the same without whitespace.
 * Changes that touch other characters are kept whole.
 */
export function ignoringWhitespace(a: string, b: string): readonly Change[] {
  return presentableDiff(a, b, DIFF_LIMITS).filter(
    (change) =>
      visible(a.slice(change.fromA, change.toA)) !== visible(b.slice(change.fromB, change.toB)),
  );
}

export function diffConfig(ignoreWhitespace: boolean): DiffConfig {
  return ignoreWhitespace ? { ...DIFF_LIMITS, override: ignoringWhitespace } : { ...DIFF_LIMITS };
}

export type LineEnding = "LF" | "CRLF" | "CR" | "mixed";

/** The line endings a text uses; null for a single line. */
export function lineEnding(text: string): LineEnding | null {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  const cr = (text.match(/\r/g)?.length ?? 0) - crlf;
  const kinds = [crlf && "CRLF", lf && "LF", cr && "CR"].filter(Boolean) as LineEnding[];
  return kinds.length === 0 ? null : kinds.length === 1 ? kinds[0]! : "mixed";
}

/** Number of lines a chunk side covers (`to` may point one past the end of the document). */
function linesIn(doc: Text, from: number, to: number): number {
  if (to <= from) return 0;
  return doc.lineAt(Math.min(to - 1, doc.length)).number - doc.lineAt(from).number + 1;
}

export interface DiffStats {
  changes: number;
  removed: number;
  added: number;
}

/** Changed regions and the lines they remove from A and add to B (a changed line counts as both). */
export function diffStats(chunks: readonly Chunk[], a: Text, b: Text): DiffStats {
  let removed = 0;
  let added = 0;
  for (const chunk of chunks) {
    removed += linesIn(a, chunk.fromA, chunk.toA);
    added += linesIn(b, chunk.fromB, chunk.toB);
  }
  return { changes: chunks.length, removed, added };
}

/** The chunk a position falls in on one side, or null. */
export function chunkAt(chunks: readonly Chunk[], side: "a" | "b", pos: number): number | null {
  const index = chunks.findIndex((chunk) => {
    const [from, to] = side === "a" ? [chunk.fromA, chunk.toA] : [chunk.fromB, chunk.toB];
    return pos >= from && (pos < to || pos === from);
  });
  return index < 0 ? null : index;
}

/** A file name safe to put in a patch header (`a/…`, `b/…`): no directories, no spaces at ends. */
export function patchName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  return base.replace(/[\t\r\n]/g, " ") || "file";
}

/**
 * A unified patch from A to B (`--- a/name`, `+++ b/name`, three lines of context). It always
 * includes whitespace changes so it applies cleanly. Computed off the main path in steps; null if
 * the texts are too different to finish within the time limit.
 */
export function unifiedPatch(
  a: string,
  b: string,
  names: { a: string; b: string },
  timeout = 5000,
): Promise<string | null> {
  return new Promise((resolve) => {
    createTwoFilesPatch(
      `a/${patchName(names.a)}`,
      `b/${patchName(names.b)}`,
      a,
      b,
      undefined,
      undefined,
      {
        context: 3,
        timeout,
        headerOptions: FILE_HEADERS_ONLY,
        callback: (patch) => resolve(patch ?? null),
      },
    );
  });
}
