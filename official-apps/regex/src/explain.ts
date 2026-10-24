/*
 * Reads a JavaScript regular expression into parts a person can follow: each part has its place
 * in the pattern, its nesting depth and a translation key with values. Syntax errors are found by
 * the RegExp constructor itself; this reader only explains what it can recognize.
 */

export interface Part {
  start: number;
  end: number;
  depth: number;
  /** Translation key under "explain." */
  key: string;
  values?: Record<string, string | number>;
}

const ESCAPES: Record<string, string> = {
  d: "digit",
  D: "nonDigit",
  w: "word",
  W: "nonWord",
  s: "space",
  S: "nonSpace",
  n: "newline",
  r: "carriageReturn",
  t: "tab",
  f: "formFeed",
  v: "verticalTab",
  "0": "nul",
};

/** How the person reads a single character (visible, or its code point). */
export function describeChar(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  if (char === " ") return "␠";
  if (code < 0x20 || (code >= 0x7f && code < 0xa0))
    return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  return char;
}

export function explain(pattern: string): Part[] {
  const parts: Part[] = [];
  let depth = 0;
  let groups = 0;
  let i = 0;
  const push = (start: number, key: string, values?: Record<string, string | number>) =>
    parts.push({ start, end: i, depth, key, ...(values ? { values } : {}) });

  while (i < pattern.length) {
    const start = i;
    const char = pattern[i]!;
    if (char === "\\") {
      const next = pattern[i + 1] ?? "";
      i += 2;
      if (next === "b") push(start, "wordBoundary");
      else if (next === "B") push(start, "nonWordBoundary");
      else if (/[1-9]/.test(next)) {
        while (/\d/.test(pattern[i] ?? "")) i += 1;
        push(start, "backreference", { number: pattern.slice(start + 1, i) });
      } else if (next === "k" && pattern[i] === "<") {
        const close = pattern.indexOf(">", i);
        i = close === -1 ? pattern.length : close + 1;
        push(start, "namedBackreference", { name: pattern.slice(start + 3, i - 1) });
      } else if ((next === "p" || next === "P") && pattern[i] === "{") {
        const close = pattern.indexOf("}", i);
        i = close === -1 ? pattern.length : close + 1;
        push(start, next === "p" ? "property" : "notProperty", {
          name: pattern.slice(start + 3, i - 1),
        });
      } else if (next === "x") {
        i += 2;
        push(start, "hex", {
          char: describeChar(String.fromCharCode(parseInt(pattern.slice(start + 2, i), 16) || 0)),
        });
      } else if (next === "u") {
        if (pattern[i] === "{") {
          const close = pattern.indexOf("}", i);
          i = close === -1 ? pattern.length : close + 1;
          const code = parseInt(pattern.slice(start + 3, i - 1), 16);
          push(start, "unicode", {
            char:
              Number.isFinite(code) && code <= 0x10ffff
                ? describeChar(String.fromCodePoint(code))
                : "?",
          });
        } else {
          i += 4;
          push(start, "unicode", {
            char: describeChar(String.fromCharCode(parseInt(pattern.slice(start + 2, i), 16) || 0)),
          });
        }
      } else if (next === "c") {
        i += 1;
        push(start, "control", { letter: pattern[i - 1] ?? "" });
      } else if (ESCAPES[next]) push(start, ESCAPES[next]);
      else push(start, "literal", { char: describeChar(next) });
      continue;
    }
    if (char === "[") {
      // A character class (nested classes of the v flag are kept whole).
      let level = 0;
      const negated = pattern[i + 1] === "^";
      do {
        if (pattern[i] === "\\") i += 2;
        else {
          if (pattern[i] === "[") level += 1;
          else if (pattern[i] === "]") level -= 1;
          i += 1;
        }
      } while (i < pattern.length && level > 0);
      const inner = pattern.slice(start + (negated ? 2 : 1), i - 1);
      push(start, negated ? "notClass" : "class", { items: inner });
      continue;
    }
    if (char === "(") {
      const rest = pattern.slice(i);
      let key = "group";
      let length = 1;
      const values: Record<string, string | number> = {};
      if (rest.startsWith("(?:")) {
        key = "nonCapturing";
        length = 3;
      } else if (rest.startsWith("(?=")) {
        key = "lookahead";
        length = 3;
      } else if (rest.startsWith("(?!")) {
        key = "negativeLookahead";
        length = 3;
      } else if (rest.startsWith("(?<=")) {
        key = "lookbehind";
        length = 4;
      } else if (rest.startsWith("(?<!")) {
        key = "negativeLookbehind";
        length = 4;
      } else if (rest.startsWith("(?<")) {
        const close = pattern.indexOf(">", i);
        groups += 1;
        key = "namedGroup";
        values.number = groups;
        values.name = pattern.slice(i + 3, close === -1 ? pattern.length : close);
        length = (close === -1 ? pattern.length : close + 1) - i;
      } else if (rest.startsWith("(?")) {
        // Modifiers such as (?i:…).
        const colon = pattern.indexOf(":", i);
        key = "modifiers";
        values.flags = pattern.slice(i + 2, colon === -1 ? i + 2 : colon);
        length = (colon === -1 ? i + 2 : colon + 1) - i;
      } else {
        groups += 1;
        values.number = groups;
      }
      i += length;
      push(start, key, values);
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      i += 1;
      push(start, "groupEnd");
      continue;
    }
    if (char === "|") {
      i += 1;
      push(start, "alternation");
      continue;
    }
    if (char === "^" || char === "$") {
      i += 1;
      push(start, char === "^" ? "start" : "end");
      continue;
    }
    if (char === ".") {
      i += 1;
      push(start, "any");
      continue;
    }
    const quantifier = /^(?:[*+?]|\{(\d+)(,(\d*))?\})(\?)?/.exec(pattern.slice(i));
    if (quantifier) {
      i += quantifier[0].length;
      const lazy = !!quantifier[4];
      const symbol = quantifier[0][0];
      if (symbol === "*") push(start, lazy ? "zeroOrMoreLazy" : "zeroOrMore");
      else if (symbol === "+") push(start, lazy ? "oneOrMoreLazy" : "oneOrMore");
      else if (symbol === "?") push(start, lazy ? "optionalLazy" : "optional");
      else {
        const min = Number(quantifier[1]);
        const hasComma = quantifier[2] !== undefined;
        const max = quantifier[3] ? Number(quantifier[3]) : null;
        const suffix = lazy ? "Lazy" : "";
        if (!hasComma) push(start, `exactly${suffix}`, { count: min });
        else if (max === null) push(start, `atLeast${suffix}`, { count: min });
        else push(start, `between${suffix}`, { min, max });
      }
      continue;
    }
    // Plain characters: one part for a run of them.
    const run = /^[^\\[\]()|^$.*+?{]+/u.exec(pattern.slice(i));
    i += run ? run[0].length : 1;
    const text = pattern.slice(start, i);
    push(start, [...text].length === 1 ? "literal" : "literals", {
      char: [...text].map(describeChar).join(""),
      text,
    });
  }
  return parts;
}

/** Group numbers of named groups (as `match` numbers them). */
export function groupNames(pattern: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const part of explain(pattern))
    if (part.key === "namedGroup")
      names.set(Number(part.values!.number), String(part.values!.name));
  return names;
}
