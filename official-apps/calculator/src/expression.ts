import { Decimal, DecimalError } from "./decimal.ts";

/*
 * The calculator's language: numbers (with a "." decimal point and optional exponent "1.5e3"),
 * + − × ÷ ^ (right-associative), unary minus, postfix ! and %, parentheses, functions of one
 * argument (sin, ln, √ …) and two (root, logb), the constants π and e, and `ans`. Multiplication
 * may be implicit: 2π, 3(4+1), (1+2)(3+4), 2sin(30). A Pratt parser builds a tree; nothing is
 * ever evaluated as JavaScript.
 */

export type ErrorCode =
  | "syntax"
  | "divide-by-zero"
  | "domain"
  | "overflow"
  | "factorial-range"
  | "unknown-name"
  | "empty";

export class CalcError extends Error {
  readonly code: ErrorCode;
  /** Where in the expression the problem is, when known. */
  readonly position: number | null;

  constructor(code: ErrorCode, position: number | null = null) {
    super(code);
    this.name = "CalcError";
    this.code = code;
    this.position = position;
  }
}

export type AngleUnit = "deg" | "rad";

type Token =
  | { kind: "number"; text: string; at: number }
  | { kind: "name"; text: string; at: number }
  | { kind: "op"; text: string; at: number }
  | { kind: "(" | ")" | ","; at: number };

const FUNCTIONS_1 = [
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "asinh",
  "acosh",
  "atanh",
  "ln",
  "log",
  "sqrt",
  "cbrt",
  "abs",
  "exp",
] as const;
const FUNCTIONS_2 = ["root", "logb"] as const;
const CONSTANTS = ["pi", "e", "ans"] as const;

type Node =
  | { kind: "number"; value: Decimal }
  | { kind: "constant"; name: (typeof CONSTANTS)[number] }
  | { kind: "unary"; op: "-" | "+"; operand: Node }
  | { kind: "postfix"; op: "!" | "%"; operand: Node }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[]; at: number };

/** Typed symbols people use for the same operations. */
const ALIASES: Record<string, string> = {
  "×": "*",
  "·": "*",
  "÷": "/",
  "−": "-",
  "–": "-",
  π: "pi",
  "√": "sqrt",
  "∛": "cbrt",
  "**": "^",
};

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
    if (number) {
      // "2e" followed by no digits is 2 × e, not an exponent.
      tokens.push({ kind: "number", text: number[0], at: i });
      i += number[0].length;
      continue;
    }
    if (source.startsWith("**", i)) {
      tokens.push({ kind: "op", text: "^", at: i });
      i += 2;
      continue;
    }
    const alias = ALIASES[char];
    if (alias === "pi" || alias === "sqrt" || alias === "cbrt") {
      tokens.push({ kind: "name", text: alias, at: i });
      i += 1;
      continue;
    }
    const name = /^[a-zA-Z]+/.exec(source.slice(i));
    if (name) {
      tokens.push({ kind: "name", text: name[0].toLowerCase(), at: i });
      i += name[0].length;
      continue;
    }
    const op = alias ?? char;
    if ("+-*/^!%".includes(op)) tokens.push({ kind: "op", text: op, at: i });
    else if (op === "(" || op === ")" || op === ",") tokens.push({ kind: op, at: i });
    else if (op === ";") tokens.push({ kind: ",", at: i });
    else throw new CalcError("syntax", i);
    i += 1;
  }
  return tokens;
}

const BINDING: Record<string, number> = { "+": 10, "-": 10, "*": 20, "/": 20, "^": 40 };
const IMPLICIT = 20;
const UNARY = 30;
const POSTFIX = 50;

class Parser {
  #tokens: Token[];
  #position = 0;
  readonly #end: number;

  constructor(tokens: Token[], end: number) {
    this.#tokens = tokens;
    this.#end = end;
  }

  #peek(): Token | undefined {
    return this.#tokens[this.#position];
  }

  #next(): Token {
    const token = this.#tokens[this.#position];
    if (!token) throw new CalcError("syntax", this.#end);
    this.#position += 1;
    return token;
  }

  parse(): Node {
    if (!this.#tokens.length) throw new CalcError("empty");
    const node = this.#expression(0);
    const rest = this.#peek();
    if (rest) throw new CalcError("syntax", rest.at);
    return node;
  }

  /** Whether `token` can start an operand (then two operands side by side multiply). */
  #startsOperand(token: Token | undefined): boolean {
    return !!token && (token.kind === "number" || token.kind === "name" || token.kind === "(");
  }

  #expression(minBinding: number): Node {
    let left = this.#prefix();
    for (;;) {
      const token = this.#peek();
      if (!token) break;
      if (token.kind === "op" && (token.text === "!" || token.text === "%")) {
        if (POSTFIX < minBinding) break;
        this.#position += 1;
        left = { kind: "postfix", op: token.text, operand: left };
        continue;
      }
      if (token.kind === "op" && token.text in BINDING) {
        const binding = BINDING[token.text]!;
        if (binding < minBinding) break;
        this.#position += 1;
        // ^ is right-associative; the others are left-associative.
        const right = this.#expression(token.text === "^" ? binding : binding + 1);
        left = { kind: "binary", op: token.text as "+" | "-" | "*" | "/" | "^", left, right };
        continue;
      }
      if (this.#startsOperand(token)) {
        if (IMPLICIT < minBinding) break;
        const right = this.#expression(IMPLICIT + 1);
        left = { kind: "binary", op: "*", left, right };
        continue;
      }
      break;
    }
    return left;
  }

  #prefix(): Node {
    const token = this.#next();
    if (token.kind === "number") return { kind: "number", value: Decimal.parse(token.text) };
    if (token.kind === "op" && (token.text === "-" || token.text === "+")) {
      // Unary minus binds looser than ^ (−2^2 = −4) and tighter than × and ÷.
      return { kind: "unary", op: token.text, operand: this.#expression(UNARY) };
    }
    if (token.kind === "(") {
      const inner = this.#expression(0);
      const close = this.#next();
      if (close.kind !== ")") throw new CalcError("syntax", close.at);
      return inner;
    }
    if (token.kind === "name") {
      if ((CONSTANTS as readonly string[]).includes(token.text))
        return { kind: "constant", name: token.text as (typeof CONSTANTS)[number] };
      if ((FUNCTIONS_1 as readonly string[]).includes(token.text)) {
        // sin(x), or sin x / √x without parentheses (binding like a unary operator).
        if (this.#peek()?.kind === "(") {
          const args = this.#arguments();
          if (args.length !== 1) throw new CalcError("syntax", token.at);
          return { kind: "call", name: token.text, args, at: token.at };
        }
        return {
          kind: "call",
          name: token.text,
          args: [this.#expression(UNARY)],
          at: token.at,
        };
      }
      if ((FUNCTIONS_2 as readonly string[]).includes(token.text)) {
        const args = this.#arguments();
        if (args.length !== 2) throw new CalcError("syntax", token.at);
        return { kind: "call", name: token.text, args, at: token.at };
      }
      throw new CalcError("unknown-name", token.at);
    }
    throw new CalcError("syntax", token.at);
  }

  #arguments(): Node[] {
    this.#next(); // (
    const args = [this.#expression(0)];
    while (this.#peek()?.kind === ",") {
      this.#position += 1;
      args.push(this.#expression(0));
    }
    const close = this.#next();
    if (close.kind !== ")") throw new CalcError("syntax", close.at);
    return args;
  }
}

export function parse(source: string): Node {
  return new Parser(tokenize(source), source.length).parse();
}

const PI = Decimal.parse("3.141592653589793238462643383279502884197");
const E = Decimal.parse("2.718281828459045235360287471352662497757");
const MAX_FACTORIAL = 3000n;

/** A double result back as a decimal (15 significant digits), with domain and range checks. */
function fromDouble(value: number): Decimal {
  if (Number.isNaN(value)) throw new CalcError("domain");
  if (!Number.isFinite(value)) throw new CalcError("overflow");
  // Values within 1e-15 of an integer are that integer (sin(π) is 0, not 1.2e-16).
  const nearest = Math.round(value);
  if (nearest !== 0 && Math.abs(value - nearest) < 1e-15 * Math.max(1, Math.abs(value)))
    return Decimal.fromNumber(nearest);
  if (Math.abs(value) < 1e-15) return Decimal.ZERO;
  return Decimal.fromNumber(value);
}

function factorial(value: Decimal): Decimal {
  if (!value.isInteger() || value.isNegative()) throw new CalcError("domain");
  const n = value.n;
  if (n > MAX_FACTORIAL) throw new CalcError("factorial-range");
  let result = 1n;
  for (let i = 2n; i <= n; i += 1n) result *= i;
  return new Decimal(result);
}

function power(base: Decimal, exponent: Decimal): Decimal {
  if (exponent.isInteger()) {
    if (base.isZero() && exponent.isNegative()) throw new CalcError("divide-by-zero");
    return base.powInt(exponent.n);
  }
  if (base.isNegative()) {
    // Odd roots of negatives are real: (−8)^(1/3) = −2.
    const reciprocal = Decimal.ONE.div(exponent);
    const rounded = reciprocal.round(12);
    if (rounded.isInteger() && rounded.n % 2n === 1n)
      return fromDouble(-Math.pow(-base.toNumber(), exponent.toNumber()));
    throw new CalcError("domain");
  }
  return fromDouble(Math.pow(base.toNumber(), exponent.toNumber()));
}

export interface EvaluateOptions {
  angle: AngleUnit;
  ans?: Decimal;
}

function toRadians(value: Decimal, angle: AngleUnit): number {
  return angle === "deg" ? value.mul(PI).div(new Decimal(180n)).toNumber() : value.toNumber();
}

function fromRadians(value: number, angle: AngleUnit): Decimal {
  return angle === "deg" ? fromDouble((value * 180) / Math.PI) : fromDouble(value);
}

/** Exact trigonometry where the answer is a known value in degrees (sin 30 = 0.5). */
function exactTrig(name: string, degrees: Decimal): Decimal | null {
  if (!degrees.isInteger()) return null;
  const turn = Number(((degrees.n % 360n) + 360n) % 360n);
  const sin: Record<number, Decimal> = {
    0: Decimal.ZERO,
    30: Decimal.parse("0.5"),
    90: Decimal.ONE,
    150: Decimal.parse("0.5"),
    180: Decimal.ZERO,
    210: Decimal.parse("-0.5"),
    270: Decimal.ONE.neg(),
    330: Decimal.parse("-0.5"),
  };
  if (name === "sin") return sin[turn] ?? null;
  if (name === "cos") return sin[(turn + 90) % 360] ?? null;
  if (name === "tan") {
    if (turn === 90 || turn === 270) throw new CalcError("domain");
    if (turn % 180 === 0) return Decimal.ZERO;
    if (turn === 45 || turn === 225) return Decimal.ONE;
    if (turn === 135 || turn === 315) return Decimal.ONE.neg();
  }
  return null;
}

function call(name: string, args: Decimal[], options: EvaluateOptions): Decimal {
  const [x = Decimal.ZERO, y = Decimal.ZERO] = args;
  const n = x.toNumber();
  switch (name) {
    case "sin":
    case "cos":
    case "tan": {
      const exact = options.angle === "deg" ? exactTrig(name, x) : null;
      if (exact) return exact;
      const radians = toRadians(x, options.angle);
      return fromDouble(Math[name](radians));
    }
    case "asin":
    case "acos":
      if (n < -1 || n > 1) throw new CalcError("domain");
      return fromRadians(Math[name](n), options.angle);
    case "atan":
      return fromRadians(Math.atan(n), options.angle);
    case "sinh":
    case "cosh":
    case "tanh":
    case "asinh":
      return fromDouble(Math[name](n));
    case "acosh":
      if (n < 1) throw new CalcError("domain");
      return fromDouble(Math.acosh(n));
    case "atanh":
      if (n <= -1 || n >= 1) throw new CalcError("domain");
      return fromDouble(Math.atanh(n));
    case "ln":
      if (n <= 0) throw new CalcError("domain");
      return fromDouble(Math.log(n));
    case "log": {
      if (n <= 0) throw new CalcError("domain");
      // Exact for powers of ten: log(1000) = 3, log(0.01) = −2.
      if (/^10*$/.test(x.n.toString())) return new Decimal(BigInt(x.magnitude()));
      return fromDouble(Math.log10(n));
    }
    case "logb": {
      const base = y.toNumber();
      if (n <= 0 || base <= 0 || base === 1) throw new CalcError("domain");
      return fromDouble(Math.log(n) / Math.log(base));
    }
    case "sqrt":
      if (x.isNegative()) throw new CalcError("domain");
      return root(x, 2n);
    case "cbrt":
      return root(x, 3n);
    case "root": {
      // root(x, n): the n-th root of x.
      if (!y.isInteger() || y.isZero()) return power(x, Decimal.ONE.div(y));
      if (x.isNegative() && y.n % 2n === 0n) throw new CalcError("domain");
      return root(x, y.n);
    }
    case "abs":
      return x.abs();
    case "exp":
      return fromDouble(Math.exp(n));
    default:
      throw new CalcError("unknown-name");
  }
}

/** n-th roots, exact when the root is a short decimal (√2.25 = 1.5, ∛−27 = −3). */
function root(x: Decimal, degree: bigint): Decimal {
  if (degree < 0n) return Decimal.ONE.div(root(x, -degree));
  const negative = x.isNegative();
  const estimate = Math.pow(Math.abs(x.toNumber()), 1 / Number(degree));
  if (!Number.isFinite(estimate)) throw new CalcError("overflow");
  const candidate = Decimal.fromNumber(estimate, 15).round(12);
  const signed = negative ? candidate.neg() : candidate;
  if (signed.powInt(degree).cmp(x) === 0) return signed;
  return fromDouble(negative ? -estimate : estimate);
}

function evaluateNode(node: Node, options: EvaluateOptions): Decimal {
  switch (node.kind) {
    case "number":
      return node.value;
    case "constant":
      return node.name === "pi" ? PI : node.name === "e" ? E : (options.ans ?? Decimal.ZERO);
    case "unary": {
      const value = evaluateNode(node.operand, options);
      return node.op === "-" ? value.neg() : value;
    }
    case "postfix": {
      const value = evaluateNode(node.operand, options);
      return node.op === "!" ? factorial(value) : value.div(new Decimal(100n));
    }
    case "binary": {
      const left = evaluateNode(node.left, options);
      const right = evaluateNode(node.right, options);
      switch (node.op) {
        case "+":
          return left.add(right);
        case "-":
          return left.sub(right);
        case "*":
          return left.mul(right);
        case "/":
          if (right.isZero()) throw new CalcError("divide-by-zero");
          return left.div(right);
        case "^":
          return power(left, right);
      }
      break;
    }
    case "call":
      return call(
        node.name,
        node.args.map((arg) => evaluateNode(arg, options)),
        options,
      );
  }
  throw new CalcError("syntax");
}

/** Evaluates an expression; throws CalcError with a code the interface explains. */
export function evaluate(source: string, options: EvaluateOptions): Decimal {
  try {
    return evaluateNode(parse(source), options);
  } catch (error) {
    if (error instanceof DecimalError)
      throw new CalcError(error.code === "invalid" ? "syntax" : error.code);
    throw error;
  }
}
