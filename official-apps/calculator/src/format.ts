import type { Decimal } from "./decimal.ts";

/*
 * Locale handling. Expressions are kept in a canonical form ("." decimal point, "," between
 * function arguments); where the person's language writes decimals with a comma, the field shows
 * "," as the decimal point and ";" between arguments, like spreadsheets do.
 */

export const DISPLAY_DIGITS = 16;

export function decimalSeparator(locale: string): "." | "," {
  const parts = new Intl.NumberFormat(locale).formatToParts(1.5);
  return parts.find((part) => part.type === "decimal")?.value === "," ? "," : ".";
}

/** What the person typed → canonical. */
export function toCanonical(text: string, decimal: "." | ","): string {
  if (decimal === ".") return text.replace(/;/g, ",");
  return [...text].map((char) => (char === "," ? "." : char === ";" ? "," : char)).join("");
}

/** Canonical → what the field shows. */
export function toDisplay(text: string, decimal: "." | ","): string {
  if (decimal === ".") return text;
  return [...text].map((char) => (char === "." ? "," : char === "," ? ";" : char)).join("");
}

/** Integers up to this many digits are shown exactly; other results are rounded. */
const EXACT_INTEGER_DIGITS = 21;

/** The value to show: exact integers, or 16 significant digits. */
function displayed(value: Decimal): { value: Decimal; scientific: boolean } {
  if (value.isInteger() && value.magnitude() < EXACT_INTEGER_DIGITS)
    return { value, scientific: false };
  const rounded = value.round(DISPLAY_DIGITS);
  const magnitude = rounded.magnitude();
  return {
    value: rounded,
    scientific: !rounded.isZero() && (magnitude >= EXACT_INTEGER_DIGITS || magnitude < -9),
  };
}

/** A result for people: localized, at most 16 significant digits, scientific when very large or small. */
export function formatResult(value: Decimal, locale: string, grouping = true): string {
  if (value.isZero()) return new Intl.NumberFormat(locale).format(0);
  const { value: rounded, scientific } = displayed(value);
  if (scientific) {
    const [mantissa = "0", exponent = "0"] = rounded.toExponential(DISPLAY_DIGITS).split("e");
    const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 20 });
    return `${format.format(mantissa as `${number}`)}e${exponent}`;
  }
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 100,
    useGrouping: grouping,
  }).format(rounded.toString() as `${number}`);
}

/** A result as an expression can contain it again (canonical, no grouping). */
export function resultExpression(value: Decimal): string {
  const { value: rounded, scientific } = displayed(value);
  return scientific ? rounded.toExponential(DISPLAY_DIGITS).replace("e+", "e") : rounded.toString();
}
