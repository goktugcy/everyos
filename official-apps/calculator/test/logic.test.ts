import { describe, expect, it } from "vitest";
import { Decimal } from "../src/decimal.ts";
import { CalcError, evaluate, type AngleUnit } from "../src/expression.ts";
import {
  decimalSeparator,
  formatResult,
  resultExpression,
  toCanonical,
  toDisplay,
} from "../src/format.ts";
import { CATEGORIES, convert } from "../src/units.ts";

const calc = (source: string, angle: AngleUnit = "deg", ans?: Decimal) =>
  resultExpression(evaluate(source, { angle, ...(ans ? { ans } : {}) }));
const fails = (source: string) => {
  try {
    evaluate(source, { angle: "deg" });
  } catch (error) {
    return error instanceof CalcError ? error.code : "other";
  }
  return null;
};

describe("exact decimals", () => {
  it("adds, multiplies and divides without binary noise", () => {
    expect(calc("0.1 + 0.2")).toBe("0.3");
    expect(calc("1.1 * 3")).toBe("3.3");
    expect(calc("10 / 4")).toBe("2.5");
    expect(calc("0.3 - 0.1")).toBe("0.2");
    expect(calc("1/3")).toBe("0.3333333333333333");
    expect(calc("1/3*3")).toBe("1");
    expect(calc("2/3")).toBe("0.6666666666666667");
    expect(calc("123456789 * 987654321")).toBe("121932631112635269");
  });

  it("keeps big integers exact and switches to scientific notation for display", () => {
    expect(new Decimal(2n).powInt(64n).toString()).toBe("18446744073709551616");
    expect(calc("2^100")).toBe("1.267650600228229e30");
    expect(formatResult(evaluate("2^100", { angle: "deg" }), "en")).toBe("1.267650600228229e+30");
    expect(calc("1/2^40")).toBe("9.094947017729282e-13");
  });

  it("rounds half to even and parses exponents", () => {
    expect(Decimal.parse("2.5").round(1).toString()).toBe("2");
    expect(Decimal.parse("3.5").round(1).toString()).toBe("4");
    expect(Decimal.parse("1.5e3").toString()).toBe("1500");
    expect(Decimal.parse("-.25").toString()).toBe("-0.25");
    expect(() => Decimal.parse("1..2")).toThrow();
  });
});

describe("expressions", () => {
  it("follows precedence, associativity and unary minus", () => {
    expect(calc("2 + 3 × 4")).toBe("14");
    expect(calc("(2 + 3) × 4")).toBe("20");
    expect(calc("2 ^ 3 ^ 2")).toBe("512");
    expect(calc("-2^2")).toBe("-4");
    expect(calc("(-2)^2")).toBe("4");
    expect(calc("2^-1")).toBe("0.5");
    expect(calc("10 − 4 − 3")).toBe("3");
    expect(calc("100 ÷ 10 ÷ 5")).toBe("2");
    expect(calc("--3")).toBe("3");
  });

  it("multiplies implicitly", () => {
    expect(calc("2π")).toBe(resultExpression(evaluate("2*pi", { angle: "deg" })));
    expect(calc("3(4+1)")).toBe("15");
    expect(calc("(1+2)(3+4)")).toBe("21");
    expect(calc("2sin(30)")).toBe("1");
    expect(calc("2e")).toBe(resultExpression(evaluate("2*e", { angle: "deg" })));
    expect(calc("2e3")).toBe("2000");
  });

  it("evaluates scientific functions in degrees and radians", () => {
    expect(calc("sin(30)")).toBe("0.5");
    expect(calc("cos(60)")).toBe("0.5");
    expect(calc("tan(45)")).toBe("1");
    expect(calc("sin(180)")).toBe("0");
    expect(calc("sin(pi/2)", "rad")).toBe("1");
    expect(calc("cos(pi)", "rad")).toBe("-1");
    expect(calc("asin(1)")).toBe("90");
    expect(calc("atan(1)", "rad")).toBe("0.785398163397448");
    expect(calc("sqrt(2.25)")).toBe("1.5");
    expect(calc("√16")).toBe("4");
    expect(calc("∛(-27)")).toBe("-3");
    expect(calc("root(32, 5)")).toBe("2");
    expect(calc("log(1000)")).toBe("3");
    expect(calc("log(0.01)")).toBe("-2");
    expect(calc("ln(e)")).toBe("1");
    expect(calc("logb(8, 2)")).toBe("3");
    expect(calc("5!")).toBe("120");
    expect(calc("20!")).toBe("2432902008176640000");
    expect(calc("abs(-4.5)")).toBe("4.5");
    expect(calc("50%")).toBe("0.5");
    expect(calc("(-8)^(1/3)")).toBe("-2");
    expect(calc("ans + 1", "deg", Decimal.parse("41"))).toBe("42");
  });

  it("reports errors with codes instead of NaN or Infinity", () => {
    expect(fails("1/0")).toBe("divide-by-zero");
    expect(fails("0^-1")).toBe("divide-by-zero");
    expect(fails("sqrt(-1)")).toBe("domain");
    expect(fails("ln(0)")).toBe("domain");
    expect(fails("asin(2)")).toBe("domain");
    expect(fails("tan(90)")).toBe("domain");
    expect(fails("(-8)^0.5")).toBe("domain");
    expect(fails("2.5!")).toBe("domain");
    expect(fails("5000!")).toBe("factorial-range");
    expect(fails("10^5000")).toBe("overflow");
    expect(fails("exp(1000)")).toBe("overflow");
    expect(fails("2 +")).toBe("syntax");
    expect(fails("(1 + 2")).toBe("syntax");
    expect(fails("1 + 2)")).toBe("syntax");
    expect(fails("foo(2)")).toBe("unknown-name");
    expect(fails("")).toBe("empty");
    expect(fails("2 # 3")).toBe("syntax");
  });
});

describe("locales", () => {
  it("reads and writes expressions with the person's decimal separator", () => {
    expect(decimalSeparator("tr")).toBe(",");
    expect(decimalSeparator("en")).toBe(".");
    expect(toCanonical("1,5 + root(8; 3)", ",")).toBe("1.5 + root(8, 3)");
    expect(toDisplay("1.5 + root(8, 3)", ",")).toBe("1,5 + root(8; 3)");
    expect(toCanonical("root(8, 3)", ".")).toBe("root(8, 3)");
    expect(formatResult(Decimal.parse("1234567.891"), "tr")).toBe("1.234.567,891");
    expect(formatResult(Decimal.parse("1234567.891"), "en", false)).toBe("1234567.891");
    expect(formatResult(Decimal.parse("0.1"), "de")).toBe("0,1");
  });
});

describe("unit conversion", () => {
  const value = (text: string) => Decimal.parse(text);
  it("converts with exact factors", () => {
    expect(convert("length", value("1"), "ft", "m").toString()).toBe("0.3048");
    expect(convert("length", value("1"), "mi", "km").toString()).toBe("1.609344");
    expect(convert("mass", value("1"), "lb", "g").toString()).toBe("453.59237");
    expect(convert("data", value("1"), "GiB", "MiB").toString()).toBe("1024");
    expect(convert("data", value("8"), "bit", "B").toString()).toBe("1");
    expect(convert("time", value("1.5"), "h", "min").toString()).toBe("90");
  });

  it("converts temperatures with offsets", () => {
    expect(convert("temperature", value("100"), "c", "f").toString()).toBe("212");
    expect(convert("temperature", value("-40"), "f", "c").toString()).toBe("-40");
    expect(convert("temperature", value("0"), "c", "k").toString()).toBe("273.15");
    expect(convert("temperature", value("98.6"), "f", "c").toString()).toBe("37");
  });

  it("round-trips every unit", () => {
    for (const category of CATEGORIES)
      for (const unit of category.units) {
        const there = convert(category.id, value("12.34"), unit.id, category.units[0]!.id);
        const back = convert(category.id, there, category.units[0]!.id, unit.id);
        expect(back.round(15).toString()).toBe("12.34");
      }
  });
});
