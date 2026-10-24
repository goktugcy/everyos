/*
 * Exact decimal numbers on BigInt: value = n × 10^-scale. Addition, subtraction, multiplication
 * and integer powers are exact (0.1 + 0.2 = 0.3); division keeps DIVISION_DIGITS significant
 * digits, rounded half to even. Functions without exact results (sin, ln …) go through doubles and
 * come back rounded to 15 significant digits, which hides binary noise without inventing digits.
 */

export const DIVISION_DIGITS = 40;
/** Results with more digits than this are refused as overflow (10^±1000 and beyond). */
const MAX_DIGITS = 1100;

const TEN = 10n;
const pow10 = (exponent: number) => TEN ** BigInt(exponent);
const digitsOf = (value: bigint) => (value < 0n ? -value : value).toString().length;

export class DecimalError extends Error {
  readonly code: "overflow" | "divide-by-zero" | "invalid";

  constructor(code: "overflow" | "divide-by-zero" | "invalid") {
    super(code);
    this.name = "DecimalError";
    this.code = code;
  }
}

/** Division of BigInts rounded half to even. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator < 0n) return divRound(-numerator, -denominator);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  const away = numerator < 0n ? -1n : 1n;
  if (twice > denominator) return quotient + away;
  if (twice < denominator) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + away;
}

export class Decimal {
  readonly n: bigint;
  readonly scale: number;

  constructor(n: bigint, scale = 0) {
    let value = n;
    let places = scale;
    while (places > 0 && value % TEN === 0n) {
      value /= TEN;
      places -= 1;
    }
    if (places < 0) {
      value *= pow10(-places);
      places = 0;
    }
    if (digitsOf(value) - places > MAX_DIGITS) throw new DecimalError("overflow");
    // Underflow becomes zero rather than an endless fraction.
    if (places > MAX_DIGITS + DIVISION_DIGITS) {
      value = divRound(value, pow10(places - (MAX_DIGITS + DIVISION_DIGITS)));
      places = MAX_DIGITS + DIVISION_DIGITS;
    }
    this.n = value;
    this.scale = value === 0n ? 0 : places;
  }

  static readonly ZERO = new Decimal(0n);
  static readonly ONE = new Decimal(1n);

  /** Parses "12", "-0.5", "1.2e-7", ".5" (a "." decimal point; callers normalize locale input). */
  static parse(text: string): Decimal {
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
    if (!match || (!match[2] && !match[3])) throw new DecimalError("invalid");
    const [, sign, whole = "", fraction = "", exponentText] = match;
    const exponent = exponentText ? Number(exponentText) : 0;
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DIGITS * 2)
      throw new DecimalError("overflow");
    const digits = BigInt(`${whole}${fraction}` || "0");
    const scale = fraction.length - exponent;
    return new Decimal(sign === "-" ? -digits : digits, scale);
  }

  /** A double, kept to `significant` digits (15 by default: what a double reliably holds). */
  static fromNumber(value: number, significant = 15): Decimal {
    if (!Number.isFinite(value))
      throw new DecimalError(Number.isNaN(value) ? "invalid" : "overflow");
    if (value === 0) return Decimal.ZERO;
    return Decimal.parse(value.toPrecision(significant));
  }

  #align(other: Decimal): [bigint, bigint, number] {
    const scale = Math.max(this.scale, other.scale);
    return [this.n * pow10(scale - this.scale), other.n * pow10(scale - other.scale), scale];
  }

  add(other: Decimal): Decimal {
    const [a, b, scale] = this.#align(other);
    return new Decimal(a + b, scale);
  }

  sub(other: Decimal): Decimal {
    const [a, b, scale] = this.#align(other);
    return new Decimal(a - b, scale);
  }

  mul(other: Decimal): Decimal {
    return new Decimal(this.n * other.n, this.scale + other.scale);
  }

  div(other: Decimal, digits = DIVISION_DIGITS): Decimal {
    if (other.isZero()) throw new DecimalError("divide-by-zero");
    if (this.isZero()) return Decimal.ZERO;
    // Enough extra places for `digits` significant digits of the quotient.
    const extra = Math.max(0, digits - (digitsOf(this.n) - digitsOf(other.n)) + 1);
    const numerator = this.n * pow10(extra + other.scale);
    const quotient = divRound(numerator, other.n);
    return new Decimal(quotient, this.scale + extra).round(digits);
  }

  neg(): Decimal {
    return new Decimal(-this.n, this.scale);
  }

  abs(): Decimal {
    return this.n < 0n ? this.neg() : this;
  }

  isZero(): boolean {
    return this.n === 0n;
  }

  isNegative(): boolean {
    return this.n < 0n;
  }

  isInteger(): boolean {
    return this.scale === 0;
  }

  cmp(other: Decimal): number {
    const [a, b] = this.#align(other);
    return a === b ? 0 : a < b ? -1 : 1;
  }

  /** Integer powers are exact (negative ones divide); others are not decimals. */
  powInt(exponent: bigint): Decimal {
    if (exponent < 0n) return Decimal.ONE.div(this.powInt(-exponent));
    if (exponent > 100_000n) {
      if (this.abs().cmp(Decimal.ONE) === 0) return exponent % 2n === 0n ? Decimal.ONE : this;
      if (this.isZero()) return this;
      throw new DecimalError("overflow");
    }
    // Bound the work: the result's digit count grows with the exponent.
    if ((digitsOf(this.n) + this.scale) * Number(exponent) > MAX_DIGITS * 4)
      throw new DecimalError("overflow");
    return new Decimal(this.n ** exponent, this.scale * Number(exponent));
  }

  /** Rounded to `significant` digits, half to even. */
  round(significant: number): Decimal {
    const digits = digitsOf(this.n);
    if (digits <= significant) return this;
    const drop = digits - significant;
    return new Decimal(divRound(this.n, pow10(drop)), this.scale - drop);
  }

  /** The decimal exponent of the leading digit (123 → 2, 0.05 → -2). */
  magnitude(): number {
    return this.isZero() ? 0 : digitsOf(this.n) - 1 - this.scale;
  }

  toNumber(): number {
    return Number(this.toString());
  }

  /** Plain notation: "-12.5", "0.001", "1000". */
  toString(): string {
    const negative = this.n < 0n;
    const digits = (negative ? -this.n : this.n).toString();
    if (this.scale === 0) return `${negative ? "-" : ""}${digits}`;
    const padded = digits.padStart(this.scale + 1, "0");
    const point = padded.length - this.scale;
    return `${negative ? "-" : ""}${padded.slice(0, point)}.${padded.slice(point)}`;
  }

  /** Scientific notation with `significant` digits: "1.2345e+20". */
  toExponential(significant: number): string {
    const rounded = this.round(significant);
    const negative = rounded.n < 0n;
    const digits = (negative ? -rounded.n : rounded.n).toString().replace(/0+$/, "") || "0";
    const exponent = rounded.magnitude();
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${negative ? "-" : ""}${mantissa}e${exponent < 0 ? "-" : "+"}${Math.abs(exponent)}`;
  }
}
