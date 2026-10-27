import type { Json, PathSegment } from "./json.ts";

/*
 * A JSONPath subset, evaluated without eval:
 *   $                  the document
 *   .name ['name']     a member          .* [*]       every member or element
 *   [2] [-1]           an element        [1:3] [::2]  a slice
 *   ['a','b'] [0,2]    several           ..name ..*   at any depth
 *   [?(@.price < 10)]  elements whose member compares (==, !=, <, <=, >, >=) with a number,
 *                      'string', true, false or null; [?(@.isbn)] those that have the member
 *   .length            the length of an array or a string
 */

export class JsonPathError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = "JsonPathError";
    this.position = position;
  }
}

export interface Match {
  path: PathSegment[];
  value: Json;
}

type Selector =
  | { kind: "name"; names: string[] }
  | { kind: "index"; indexes: number[] }
  | { kind: "wildcard" }
  | { kind: "slice"; start: number | null; end: number | null; step: number }
  | { kind: "filter"; path: PathSegment[]; op: Op | null; literal: Json };

type Op = "==" | "!=" | "<" | "<=" | ">" | ">=";

interface Step {
  descendant: boolean;
  selector: Selector;
}

class Reader {
  readonly text: string;
  index = 0;

  constructor(text: string) {
    this.text = text;
  }

  peek(offset = 0): string | undefined {
    return this.text[this.index + offset];
  }

  skip(): void {
    while (this.peek() === " ") this.index += 1;
  }

  expect(char: string): void {
    this.skip();
    if (this.peek() !== char) throw new JsonPathError(`Expected “${char}”`, this.index);
    this.index += 1;
  }

  name(): string {
    const match = /^[A-Za-z_$À-￿][\w$À-￿-]*/.exec(this.text.slice(this.index));
    if (!match) throw new JsonPathError("Expected a name", this.index);
    this.index += match[0].length;
    return match[0];
  }

  quoted(): string {
    const quote = this.peek();
    if (quote !== "'" && quote !== '"')
      throw new JsonPathError("Expected a quoted name", this.index);
    let out = "";
    this.index += 1;
    while (this.index < this.text.length && this.peek() !== quote) {
      if (this.peek() === "\\") this.index += 1;
      out += this.peek() ?? "";
      this.index += 1;
    }
    if (this.peek() !== quote) throw new JsonPathError("Unclosed quote", this.index);
    this.index += 1;
    return out;
  }

  integer(): number | null {
    this.skip();
    const match = /^-?\d+/.exec(this.text.slice(this.index));
    if (!match) return null;
    this.index += match[0].length;
    return Number(match[0]);
  }
}

function literal(reader: Reader): Json {
  reader.skip();
  const char = reader.peek();
  if (char === "'" || char === '"') return reader.quoted();
  const rest = reader.text.slice(reader.index);
  for (const [word, value] of [
    ["true", true],
    ["false", false],
    ["null", null],
  ] as const)
    if (rest.startsWith(word)) {
      reader.index += word.length;
      return value;
    }
  const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
  if (!number) throw new JsonPathError("Expected a value", reader.index);
  reader.index += number[0].length;
  return Number(number[0]);
}

function relativePath(reader: Reader): PathSegment[] {
  reader.skip();
  if (reader.peek() !== "@") throw new JsonPathError("Expected @", reader.index);
  reader.index += 1;
  const path: PathSegment[] = [];
  for (;;) {
    if (reader.peek() === ".") {
      reader.index += 1;
      path.push(reader.name());
    } else if (reader.peek() === "[") {
      reader.index += 1;
      reader.skip();
      const index = reader.integer();
      path.push(index ?? reader.quoted());
      reader.expect("]");
    } else return path;
  }
}

function bracket(reader: Reader): Selector {
  reader.skip();
  const char = reader.peek();
  if (char === "*") {
    reader.index += 1;
    reader.expect("]");
    return { kind: "wildcard" };
  }
  if (char === "?") {
    reader.index += 1;
    reader.expect("(");
    const path = relativePath(reader);
    reader.skip();
    const op = /^(==|!=|<=|>=|<|>)/.exec(reader.text.slice(reader.index))?.[1] as Op | undefined;
    let value: Json = null;
    if (op) {
      reader.index += op.length;
      value = literal(reader);
    }
    reader.expect(")");
    reader.expect("]");
    return { kind: "filter", path, op: op ?? null, literal: value };
  }
  if (char === "'" || char === '"') {
    const names = [reader.quoted()];
    reader.skip();
    while (reader.peek() === ",") {
      reader.index += 1;
      reader.skip();
      names.push(reader.quoted());
      reader.skip();
    }
    reader.expect("]");
    return { kind: "name", names };
  }
  const first = reader.integer();
  reader.skip();
  if (reader.peek() === ":") {
    reader.index += 1;
    const end = reader.integer();
    reader.skip();
    let step = 1;
    if (reader.peek() === ":") {
      reader.index += 1;
      step = reader.integer() ?? 1;
      if (step === 0) throw new JsonPathError("A slice step cannot be 0", reader.index);
    }
    reader.expect("]");
    return { kind: "slice", start: first, end, step };
  }
  if (first === null) throw new JsonPathError("Expected an index, a name, * or ?()", reader.index);
  const indexes = [first];
  while (reader.peek() === ",") {
    reader.index += 1;
    const next = reader.integer();
    if (next === null) throw new JsonPathError("Expected an index", reader.index);
    indexes.push(next);
    reader.skip();
  }
  reader.expect("]");
  return { kind: "index", indexes };
}

export function compile(source: string): Step[] {
  const reader = new Reader(source.trim());
  if (reader.peek() !== "$") throw new JsonPathError("A path starts with $", 0);
  reader.index = 1;
  const steps: Step[] = [];
  while (reader.index < reader.text.length) {
    const char = reader.peek();
    if (char === ".") {
      const descendant = reader.peek(1) === ".";
      reader.index += descendant ? 2 : 1;
      if (reader.peek() === "*") {
        reader.index += 1;
        steps.push({ descendant, selector: { kind: "wildcard" } });
      } else if (reader.peek() === "[" && descendant) {
        reader.index += 1;
        steps.push({ descendant, selector: bracket(reader) });
      } else steps.push({ descendant, selector: { kind: "name", names: [reader.name()] } });
    } else if (char === "[") {
      reader.index += 1;
      steps.push({ descendant: false, selector: bracket(reader) });
    } else if (char === " ") reader.index += 1;
    else throw new JsonPathError(`Unexpected “${char}”`, reader.index);
  }
  return steps;
}

function children(value: Json): Array<[PathSegment, Json]> {
  if (Array.isArray(value)) return value.map((item, index) => [index, item]);
  if (value && typeof value === "object") return Object.entries(value);
  return [];
}

function get(value: Json, path: readonly PathSegment[]): Json | undefined {
  let current: Json | undefined = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current)
      ? typeof segment === "number"
        ? current[segment < 0 ? current.length + segment : segment]
        : undefined
      : (current as Record<string, Json>)[String(segment)];
  }
  return current;
}

function ordered(left: Json, right: Json): [number, number] | [string, string] | null {
  if (typeof left === "number" && typeof right === "number") return [left, right];
  if (typeof left === "string" && typeof right === "string") return [left, right];
  return null;
}

function compare(left: Json | undefined, op: Op, right: Json): boolean {
  if (left === undefined) return false;
  if (op === "==") return JSON.stringify(left) === JSON.stringify(right);
  if (op === "!=") return JSON.stringify(left) !== JSON.stringify(right);
  // Order only between two numbers or two strings.
  const pair = ordered(left, right);
  if (!pair) return false;
  const [a, b] = pair;
  return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
}

function select(match: Match, selector: Selector): Match[] {
  const { value, path } = match;
  switch (selector.kind) {
    case "wildcard":
      return children(value).map(([key, child]) => ({ path: [...path, key], value: child }));
    case "name":
      return selector.names.flatMap((name) => {
        if (value && typeof value === "object" && !Array.isArray(value) && name in value)
          return [{ path: [...path, name], value: value[name]! }];
        if (name === "length" && (Array.isArray(value) || typeof value === "string"))
          return [{ path: [...path, "length"], value: value.length }];
        return [];
      });
    case "index":
      if (!Array.isArray(value)) return [];
      return selector.indexes.flatMap((raw) => {
        const index = raw < 0 ? value.length + raw : raw;
        return index >= 0 && index < value.length
          ? [{ path: [...path, index], value: value[index]! }]
          : [];
      });
    case "slice": {
      if (!Array.isArray(value)) return [];
      const length = value.length;
      const clamp = (index: number) =>
        Math.min(length, Math.max(0, index < 0 ? length + index : index));
      const out: Match[] = [];
      if (selector.step > 0) {
        const start = clamp(selector.start ?? 0);
        const end = clamp(selector.end ?? length);
        for (let index = start; index < end; index += selector.step)
          out.push({ path: [...path, index], value: value[index]! });
      } else {
        const start =
          selector.start === null ? length - 1 : Math.min(length - 1, clamp(selector.start));
        const end = selector.end === null ? -1 : clamp(selector.end);
        for (let index = start; index > end; index += selector.step)
          out.push({ path: [...path, index], value: value[index]! });
      }
      return out;
    }
    case "filter":
      return children(value)
        .filter(([, child]) => {
          const found = get(child, selector.path);
          return selector.op ? compare(found, selector.op, selector.literal) : found !== undefined;
        })
        .map(([key, child]) => ({ path: [...path, key], value: child }));
  }
}

function descendants(match: Match): Match[] {
  const out: Match[] = [match];
  for (const [key, child] of children(match.value))
    out.push(...descendants({ path: [...match.path, key], value: child }));
  return out;
}

/** Everything `source` selects in `document` (at most `limit` results). */
export function query(document: Json, source: string, limit = 10_000): Match[] {
  let matches: Match[] = [{ path: [], value: document }];
  for (const step of compile(source)) {
    const scope = step.descendant ? matches.flatMap(descendants) : matches;
    matches = scope.flatMap((match) => select(match, step.selector));
    if (matches.length > limit) matches = matches.slice(0, limit);
  }
  return matches;
}
