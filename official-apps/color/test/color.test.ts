import { describe, expect, it } from "vitest";
import {
  contrast,
  cssVariables,
  gradientCss,
  harmony,
  hslToRgb,
  hsvToRgb,
  inSrgbGamut,
  oklchToRgb,
  parseColor,
  rgbToHsl,
  rgbToHsv,
  rgbToOklch,
  scale,
  toHex,
  toHslString,
  toOklchString,
  toRgbString,
  wcag,
} from "../src/color.ts";

const rgb = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });

describe("parsing and formatting", () => {
  it("reads every format it writes", () => {
    for (const input of [
      "#0284c7",
      "#08c",
      "#0284c780",
      "rgb(2 132 199)",
      "rgb(2, 132, 199)",
      "rgba(2,132,199,0.5)",
      "hsl(200.6 98% 39.4%)",
      "hsl(200deg, 98%, 39%)",
      "oklch(58.84% 0.1389 241.97)",
      "royalblue",
      "transparent",
    ])
      expect(parseColor(input), input).not.toBeNull();
    expect(toHex(parseColor("#08c")!)).toBe("#0088cc");
    expect(toHex(parseColor("rgb(2 132 199 / 50%)")!)).toBe("#0284c780");
    expect(parseColor("not a color")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
    const color = parseColor("#0284c7")!;
    expect(toRgbString(color)).toBe("rgb(2 132 199)");
    expect(toHslString(color)).toBe("hsl(200.4 98% 39.4%)");
    expect(toOklchString(color)).toMatch(/^oklch\(58\.\d+% 0\.13\d+ 2\d\d\.\d+\)$/);
    for (const text of [toRgbString(color), toHslString(color), toOklchString(color)])
      expect(toHex(parseColor(text)!), text).toBe("#0284c7");
  });
});

describe("conversions", () => {
  it("round-trips HSL, HSV and OKLCH", () => {
    for (const color of [
      rgb(2, 132, 199),
      rgb(255, 0, 0),
      rgb(18, 18, 18),
      rgb(250, 240, 230),
      rgb(0, 255, 127),
    ]) {
      expect(toHex(hslToRgb(rgbToHsl(color)))).toBe(toHex(color));
      expect(toHex(hsvToRgb(rgbToHsv(color)))).toBe(toHex(color));
      expect(toHex(oklchToRgb(rgbToOklch(color)))).toBe(toHex(color));
    }
    expect(rgbToOklch(rgb(255, 255, 255)).l).toBeCloseTo(1, 4);
    expect(rgbToOklch(rgb(0, 0, 0)).l).toBeCloseTo(0, 4);
  });

  it("brings colors outside sRGB in by lowering chroma", () => {
    const vivid = { l: 0.7, c: 0.4, h: 150 };
    expect(inSrgbGamut(vivid)).toBe(false);
    const fitted = oklchToRgb(vivid);
    for (const channel of [fitted.r, fitted.g, fitted.b]) expect(channel).toBeGreaterThanOrEqual(0);
    expect(rgbToOklch(fitted).l).toBeCloseTo(0.7, 2);
    expect(rgbToOklch(fitted).h).toBeCloseTo(150, 0);
  });
});

describe("contrast", () => {
  it("computes WCAG 2 ratios and levels", () => {
    expect(contrast(rgb(0, 0, 0), rgb(255, 255, 255))).toBeCloseTo(21, 5);
    expect(contrast(rgb(255, 255, 255), rgb(255, 255, 255))).toBe(1);
    expect(contrast(rgb(118, 118, 118), rgb(255, 255, 255))).toBeCloseTo(4.54, 2);
    expect(wcag(4.54)).toEqual({ aa: true, aaLarge: true, aaa: false, aaaLarge: true });
    // Translucent text is composited over its background first.
    expect(contrast(rgb(0, 0, 0, 0.5), rgb(255, 255, 255))).toBeLessThan(5);
  });
});

describe("palettes and gradients", () => {
  it("builds harmonies around the hue", () => {
    const base = rgb(2, 132, 199);
    const hue = rgbToOklch(base).h;
    const [, complement] = harmony(base, "complementary");
    expect((rgbToOklch(complement!).h - hue + 360) % 360).toBeCloseTo(180, -1);
    expect(harmony(base, "triadic")).toHaveLength(3);
    expect(harmony(base, "tetradic")).toHaveLength(4);
    expect(harmony(base, "monochromatic")).toHaveLength(5);
  });

  it("builds a tonal scale from light to dark", () => {
    const tones = scale(rgb(2, 132, 199));
    expect(tones.map((tone) => tone.step)).toEqual([
      50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
    ]);
    const lightness = tones.map((tone) => rgbToOklch(tone.color).l);
    for (let index = 1; index < lightness.length; index += 1)
      expect(lightness[index]!).toBeLessThan(lightness[index - 1]!);
  });

  it("writes CSS", () => {
    expect(cssVariables("Brand Blue", [rgb(2, 132, 199), rgb(79, 70, 229)], [500, 600])).toBe(
      ":root {\n  --brand-blue-500: #0284c7;\n  --brand-blue-600: #4f46e5;\n}\n",
    );
    expect(
      gradientCss({
        kind: "linear",
        angle: 135,
        stops: [
          { color: rgb(79, 70, 229), at: 100 },
          { color: rgb(2, 132, 199), at: 0 },
        ],
      }),
    ).toBe("linear-gradient(135deg, #0284c7 0%, #4f46e5 100%)");
    expect(
      gradientCss({
        kind: "radial",
        angle: 0,
        stops: [
          { color: rgb(0, 0, 0), at: 0 },
          { color: rgb(255, 255, 255), at: 100 },
        ],
      }),
    ).toBe("radial-gradient(circle, #000000 0%, #ffffff 100%)");
  });
});
