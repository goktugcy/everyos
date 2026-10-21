/*
 * Color math for Color Studio: sRGB with alpha as the stored form, conversions to HSL, HSV and
 * OKLCH (Björn Ottosson's Oklab), parsing and formatting of CSS colors, WCAG 2 contrast, harmonies
 * and tonal scales. OKLCH colors outside sRGB are brought in by reducing chroma, keeping lightness
 * and hue.
 */

/** Channels 0–255 (fractional allowed), alpha 0–1. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export interface Hsv {
  h: number;
  s: number;
  v: number;
}

/** L 0–1, C ≥ 0 (about 0.37 at most in sRGB), h degrees. */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const wrapHue = (hue: number) => ((hue % 360) + 360) % 360;

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return { h: wrapHue(h * 60), s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl, a = 1): Rgb {
  const sn = clamp(s / 100);
  const ln = clamp(l / 100);
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = wrapHue(h) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = ln - c / 2;
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255, a };
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const d = max - Math.min(rn, gn, bn);
  const h =
    d === 0
      ? 0
      : max === rn
        ? ((gn - bn) / d) % 6
        : max === gn
          ? (bn - rn) / d + 2
          : (rn - gn) / d + 4;
  return { h: wrapHue(h * 60), s: max === 0 ? 0 : (d / max) * 100, v: max * 100 };
}

export function hsvToRgb({ h, s, v }: Hsv, a = 1): Rgb {
  const sn = clamp(s / 100);
  const vn = clamp(v / 100);
  const l = vn * (1 - sn / 2);
  const sl = l === 0 || l === 1 ? 0 : (vn - l) / Math.min(l, 1 - l);
  return hslToRgb({ h, s: sl * 100, l: l * 100 }, a);
}

const toLinear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (value: number) =>
  255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.sqrt(A * A + B * B);
  return { l: L, c, h: c < 1e-4 ? 0 : wrapHue((Math.atan2(B, A) * 180) / Math.PI) };
}

/** OKLCH to linear sRGB (may be outside 0–1). */
function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const B = c * Math.sin(rad);
  const l1 = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m1 = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s1 = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  ];
}

export function inSrgbGamut(color: Oklch): boolean {
  return oklchToLinear(color).every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
}

/** OKLCH to sRGB; outside the gamut, chroma is reduced until the color fits. */
export function oklchToRgb(color: Oklch, a = 1): Rgb {
  let fitted = { ...color, l: clamp(color.l) };
  if (!inSrgbGamut(fitted)) {
    let low = 0;
    let high = fitted.c;
    for (let step = 0; step < 24; step += 1) {
      const mid = (low + high) / 2;
      if (inSrgbGamut({ ...fitted, c: mid })) low = mid;
      else high = mid;
    }
    fitted = { ...fitted, c: low };
  }
  const [r, g, b] = oklchToLinear(fitted).map((channel) =>
    clamp(fromLinear(clamp(channel)), 0, 255),
  );
  return { r: r!, g: g!, b: b!, a };
}

/* ------------------------------------------------------------------ parsing and formatting */

const NAMED: Record<string, string> = {
  black: "000000",
  white: "ffffff",
  red: "ff0000",
  lime: "00ff00",
  blue: "0000ff",
  yellow: "ffff00",
  cyan: "00ffff",
  aqua: "00ffff",
  magenta: "ff00ff",
  fuchsia: "ff00ff",
  silver: "c0c0c0",
  gray: "808080",
  grey: "808080",
  maroon: "800000",
  olive: "808000",
  green: "008000",
  purple: "800080",
  teal: "008080",
  navy: "000080",
  orange: "ffa500",
  pink: "ffc0cb",
  brown: "a52a2a",
  gold: "ffd700",
  indigo: "4b0082",
  violet: "ee82ee",
  coral: "ff7f50",
  salmon: "fa8072",
  tomato: "ff6347",
  crimson: "dc143c",
  orchid: "da70d6",
  plum: "dda0dd",
  khaki: "f0e68c",
  beige: "f5f5dc",
  ivory: "fffff0",
  lavender: "e6e6fa",
  turquoise: "40e0d0",
  tan: "d2b48c",
  chocolate: "d2691e",
  sienna: "a0522d",
  skyblue: "87ceeb",
  steelblue: "4682b4",
  royalblue: "4169e1",
  slategray: "708090",
  mintcream: "f5fffa",
  rebeccapurple: "663399",
  transparent: "00000000",
};

function hexToRgb(hex: string): Rgb | null {
  const value = hex.replace(/^#/, "");
  if (!/^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return null;
  const full = value.length <= 4 ? [...value].map((char) => char + char).join("") : value;
  const n = (index: number) => parseInt(full.slice(index, index + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? round(n(6) / 255, 3) : 1 };
}

function number(token: string, scale: number): number | null {
  const match = /^(-?\d*\.?\d+)(%|deg|turn|rad)?$/.exec(token.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === "%") return (value / 100) * scale;
  if (unit === "turn") return value * 360;
  if (unit === "rad") return (value * 180) / Math.PI;
  return value;
}

/** Parses hex, rgb(), hsl(), oklch() and common color names; null when it is none of them. */
export function parseColor(input: string): Rgb | null {
  const text = input.trim().toLowerCase();
  if (NAMED[text]) return hexToRgb(NAMED[text]);
  if (text.startsWith("#") || /^[0-9a-f]{6}$/.test(text)) return hexToRgb(text);
  const match = /^(rgba?|hsla?|oklch)\((.*)\)$/.exec(text);
  if (!match) return null;
  const parts = match[2]!
    .replace(/\s*\/\s*/, " / ")
    .split(/[\s,]+(?![^(]*\))/)
    .filter((part) => part && part !== "/");
  const slash = match[2]!.includes("/") || parts.length === 4;
  const alphaText = slash ? parts[3] : undefined;
  const alpha = alphaText === undefined ? 1 : number(alphaText, 1);
  if (alpha === null || parts.length < 3) return null;
  if (match[1]!.startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map((part) => number(part, 255));
    if ([r, g, b].some((value) => value === null || value === undefined)) return null;
    return { r: clamp(r!, 0, 255), g: clamp(g!, 0, 255), b: clamp(b!, 0, 255), a: clamp(alpha) };
  }
  if (match[1]!.startsWith("hsl")) {
    const h = number(parts[0]!, 360);
    const s = number(parts[1]!.replace("%", "") + "%", 100);
    const l = number(parts[2]!.replace("%", "") + "%", 100);
    if (h === null || s === null || l === null) return null;
    return hslToRgb({ h, s, l }, clamp(alpha));
  }
  const l = number(parts[0]!, 1);
  const c = number(parts[1]!, 0.4);
  const h = number(parts[2]!, 360);
  if (l === null || c === null || h === null) return null;
  return oklchToRgb({ l: parts[0]!.endsWith("%") ? l : l > 1 ? l / 100 : l, c, h }, clamp(alpha));
}

const hex2 = (value: number) =>
  Math.round(clamp(value, 0, 255))
    .toString(16)
    .padStart(2, "0");

export function toHex(color: Rgb, withAlpha = color.a < 1): string {
  return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}${withAlpha ? hex2(color.a * 255) : ""}`;
}

export function toRgbString(color: Rgb): string {
  const [r, g, b] = [color.r, color.g, color.b].map((value) => Math.round(value));
  return color.a < 1 ? `rgb(${r} ${g} ${b} / ${round(color.a, 3)})` : `rgb(${r} ${g} ${b})`;
}

export function toHslString(color: Rgb): string {
  const { h, s, l } = rgbToHsl(color);
  const body = `${round(h, 1)} ${round(s, 1)}% ${round(l, 1)}%`;
  return color.a < 1 ? `hsl(${body} / ${round(color.a, 3)})` : `hsl(${body})`;
}

export function toOklchString(color: Rgb): string {
  const { l, c, h } = rgbToOklch(color);
  const body = `${round(l * 100, 2)}% ${round(c, 4)} ${round(h, 2)}`;
  return color.a < 1 ? `oklch(${body} / ${round(color.a, 3)})` : `oklch(${body})`;
}

/* ------------------------------------------------------------------ contrast */

export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Composites a translucent color over an opaque background. */
export function over(top: Rgb, bottom: Rgb): Rgb {
  const mix = (a: number, b: number) => a * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

/** WCAG 2 contrast ratio, 1–21 (text composited over its background). */
export function contrast(text: Rgb, background: Rgb): number {
  const a = luminance(over(text, { ...background, a: 1 }));
  const b = luminance({ ...background, a: 1 });
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

export function wcag(ratio: number) {
  return {
    aa: ratio >= 4.5,
    aaLarge: ratio >= 3,
    aaa: ratio >= 7,
    aaaLarge: ratio >= 4.5,
  };
}

/* ------------------------------------------------------------------ palettes */

export type Harmony =
  "complementary" | "analogous" | "triadic" | "split" | "tetradic" | "monochromatic";

export const HARMONIES: readonly Harmony[] = [
  "complementary",
  "analogous",
  "triadic",
  "split",
  "tetradic",
  "monochromatic",
];

/** Colors that go with `base`, rotating the OKLCH hue (perceptually even). */
export function harmony(base: Rgb, kind: Harmony): Rgb[] {
  const oklch = rgbToOklch(base);
  const rotate = (degrees: number) =>
    oklchToRgb({ ...oklch, h: wrapHue(oklch.h + degrees) }, base.a);
  switch (kind) {
    case "complementary":
      return [base, rotate(180)];
    case "analogous":
      return [rotate(-30), base, rotate(30)];
    case "triadic":
      return [base, rotate(120), rotate(240)];
    case "split":
      return [base, rotate(150), rotate(210)];
    case "tetradic":
      return [base, rotate(90), rotate(180), rotate(270)];
    case "monochromatic":
      return [0.3, 0.45, 0.6, 0.75, 0.9].map((l) => oklchToRgb({ ...oklch, l }, base.a));
  }
}

export const SCALE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const SCALE_LIGHTNESS = [0.975, 0.94, 0.885, 0.81, 0.71, 0.62, 0.53, 0.45, 0.38, 0.31, 0.24];

/** A tonal scale (50–950) around the color's hue and chroma, lighter to darker. */
export function scale(base: Rgb): Array<{ step: number; color: Rgb }> {
  const { c, h } = rgbToOklch(base);
  return SCALE_STEPS.map((step, index) => {
    const l = SCALE_LIGHTNESS[index]!;
    // Very light and very dark steps carry less chroma, as palettes usually do.
    const fade = 1 - Math.abs(l - 0.6) * 0.9;
    return { step, color: oklchToRgb({ l, c: c * Math.max(0.25, fade), h }) };
  });
}

/** CSS custom properties for a named list of colors. */
export function cssVariables(
  name: string,
  colors: readonly Rgb[],
  steps?: readonly number[],
): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "color";
  const lines = colors.map(
    (color, index) => `  --${slug}-${steps?.[index] ?? index + 1}: ${toHex(color)};`,
  );
  return `:root {\n${lines.join("\n")}\n}\n`;
}

/* ------------------------------------------------------------------ gradients */

export interface GradientStop {
  color: Rgb;
  /** 0–100 */
  at: number;
}

export interface Gradient {
  kind: "linear" | "radial";
  angle: number;
  stops: GradientStop[];
}

export function gradientCss(gradient: Gradient): string {
  const stops = [...gradient.stops]
    .sort((a, b) => a.at - b.at)
    .map((stop) => `${toHex(stop.color)} ${round(stop.at, 1)}%`)
    .join(", ");
  return gradient.kind === "linear"
    ? `linear-gradient(${round(gradient.angle)}deg, ${stops})`
    : `radial-gradient(circle, ${stops})`;
}
