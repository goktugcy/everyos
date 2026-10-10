import { THEME_PRESET_IDS, WALLPAPER_PRESET_IDS, type AppearancePreferences } from "@otuken/shared";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  DEFAULT_APPEARANCE,
  exportTheme,
  importTheme,
  MIN_TEXT_CONTRAST,
  parseHex,
  resolveTheme,
  surfaceContrast,
  themeCssVariables,
  THEME_PRESETS,
  wallpaperBackdrops,
} from "./index.ts";

const settings = (overrides: Partial<AppearancePreferences>): AppearancePreferences => ({
  ...DEFAULT_APPEARANCE,
  ...overrides,
});

function textContrasts(appearance: AppearancePreferences) {
  const theme = resolveTheme(appearance);
  const backdrops = wallpaperBackdrops(theme.wallpaper);
  const { palette, effects } = theme;
  return {
    theme,
    values: [palette.text, palette.textMuted, palette.textSubtle].map((tone) =>
      surfaceContrast(tone, palette.surface, effects.surfaceOpacity, backdrops),
    ),
  };
}

describe("theme presets", () => {
  it("defines all seven presets with matching ids", () => {
    expect(Object.keys(THEME_PRESETS).sort()).toEqual([...THEME_PRESET_IDS].sort());
  });

  it.each(THEME_PRESET_IDS)("%s keeps every text tone at WCAG AA on its wallpaper", (themeId) => {
    for (const renderMode of ["performance", "balanced", "premium"] as const) {
      const { values } = textContrasts(settings({ themeId, renderMode }));
      for (const value of values) expect(value).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it.each(THEME_PRESET_IDS)("%s keeps primary button labels readable", (themeId) => {
    const theme = resolveTheme(settings({ themeId }));
    const text = parseHex(theme.accentContrast);
    expect(contrastRatio(text, parseHex(theme.button.from))).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST,
    );
    expect(contrastRatio(text, parseHex(theme.button.to))).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST,
    );
  });
});

describe("user customization", () => {
  it("never lets surface opacity drop below the readable minimum", () => {
    for (const themeId of THEME_PRESET_IDS) {
      const { theme, values } = textContrasts(
        settings({ themeId, effects: { surfaceOpacity: 0.3 } }),
      );
      expect(theme.effects.surfaceOpacity).toBeGreaterThanOrEqual(theme.minReadableOpacity);
      for (const value of values) expect(value).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it("assumes the worst case for uploaded images", () => {
    for (const themeId of THEME_PRESET_IDS) {
      const { values } = textContrasts(
        settings({
          themeId,
          effects: { surfaceOpacity: 0.3 },
          wallpaper: { kind: "image", wallpaperId: "abc", fit: "cover" },
        }),
      );
      for (const value of values) expect(value).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it("keeps button labels readable for any accent color", () => {
    for (const accent of [
      "#777777",
      "#ffff00",
      "#000080",
      "#ff00ff",
      "#00ff00",
      "#808000",
      "#ffffff",
      "#000000",
    ]) {
      const theme = resolveTheme(settings({ accent }));
      const text = parseHex(theme.accentContrast);
      expect(contrastRatio(text, parseHex(theme.button.from)), accent).toBeGreaterThanOrEqual(
        MIN_TEXT_CONTRAST,
      );
      expect(contrastRatio(text, parseHex(theme.button.to)), accent).toBeGreaterThanOrEqual(
        MIN_TEXT_CONTRAST,
      );
      expect(theme.palette.accent).toBe(accent);
    }
  });

  it("applies custom themes and falls back safely for unknown ids", () => {
    const custom = settings({
      themeId: "custom:mine",
      customThemes: [
        {
          id: "mine",
          name: "Mine",
          base: "neon-night",
          accent: "#33ccff",
          effects: { radius: 8 },
          wallpaper: null,
        },
      ],
    });
    const theme = resolveTheme(custom);
    expect(theme.id).toBe("custom:mine");
    expect(theme.palette.accent).toBe("#33ccff");
    expect(theme.effects.radius).toBe(8);
    expect(theme.wallpaper).toEqual({ kind: "preset", id: "neon" });
    expect(resolveTheme(settings({ themeId: "custom:gone" })).id).toBe("liquid-dark");
    expect(resolveTheme(settings({ themeId: "nonsense" })).id).toBe("liquid-dark");
  });
});

describe("render modes", () => {
  it("performance disables expensive effects", () => {
    const theme = resolveTheme(settings({ renderMode: "performance", effects: { blur: 30 } }));
    expect(theme.effects.blur).toBe(0);
    expect(theme.effects.surfaceOpacity).toBeGreaterThanOrEqual(0.94);
    expect(theme.wallpaperAnimated).toBe(false);
    expect(theme.windowAnimation).toBe("none");
  });

  it("balanced caps blur, premium keeps it", () => {
    expect(
      resolveTheme(settings({ renderMode: "balanced", effects: { blur: 30 } })).effects.blur,
    ).toBe(16);
    expect(
      resolveTheme(settings({ renderMode: "premium", effects: { blur: 30 } })).effects.blur,
    ).toBe(30);
  });

  it("only animates animatable preset wallpapers", () => {
    expect(
      resolveTheme(settings({ wallpaper: { kind: "preset", id: "graphite" } })).wallpaperAnimated,
    ).toBe(false);
    expect(
      resolveTheme(settings({ wallpaper: { kind: "solid", color: "#123456" } })).wallpaperAnimated,
    ).toBe(false);
    expect(
      resolveTheme(settings({ wallpaper: { kind: "preset", id: "aurora" } })).wallpaperAnimated,
    ).toBe(true);
  });
});

describe("CSS variables", () => {
  it("emits triplets and units for every token", () => {
    const vars = themeCssVariables(resolveTheme(DEFAULT_APPEARANCE));
    expect(vars["--otk-accent"]).toBe("125 211 252");
    expect(vars["--otk-blur"]).toBe("16px");
    expect(vars["--otk-radius-lg"]).toBe("22px");
    expect(vars["--otk-icon-size"]).toBe("52px");
    for (const [name, value] of Object.entries(vars)) {
      expect(name.startsWith("--otk-")).toBe(true);
      expect(value).not.toMatch(/[;{}<>]/);
    }
  });

  it("switches neutral overlays for light themes", () => {
    const vars = themeCssVariables(resolveTheme(settings({ themeId: "liquid-light" })));
    expect(vars["--otk-hover"]).toBe("15 23 42");
    expect(vars["--otk-inset"]).toBe("255 255 255");
  });

  it("covers every wallpaper preset", () => {
    for (const id of WALLPAPER_PRESET_IDS) {
      expect(wallpaperBackdrops({ kind: "preset", id }).length).toBeGreaterThan(1);
    }
  });
});

describe("theme files", () => {
  const theme = {
    id: "t1",
    name: "Gece Mavisi",
    base: "frost-blue" as const,
    accent: "#4488ff",
    effects: { blur: 10, radius: 16 },
    wallpaper: { kind: "image" as const, wallpaperId: "private", fit: "cover" as const },
  };

  it("round-trips without leaking private image references", () => {
    const text = exportTheme(theme);
    expect(text).not.toContain("private");
    const imported = importTheme(text, "t2");
    expect(imported).toEqual({ ok: true, theme: { ...theme, id: "t2", wallpaper: null } });
  });

  it("rejects malformed or out-of-range files", () => {
    expect(importTheme("{", "x")).toEqual({ ok: false, error: "not-json" });
    expect(importTheme(JSON.stringify({ format: "other" }), "x")).toEqual({
      ok: false,
      error: "wrong-format",
    });
    const base = JSON.parse(exportTheme(theme)) as {
      schemaVersion: number;
      theme: Record<string, unknown>;
    };
    expect(importTheme(JSON.stringify({ ...base, schemaVersion: 9 }), "x")).toEqual({
      ok: false,
      error: "unsupported-version",
    });
    for (const patch of [
      { accent: "red" },
      { base: "windows-xp" },
      { name: "" },
      { effects: { blur: 999 } },
      { effects: { evil: 1 } },
      { wallpaper: { kind: "image", wallpaperId: "x", fit: "cover" } },
      {
        wallpaper: { kind: "gradient", from: "#000000", to: "url(javascript:alert(1))", angle: 10 },
      },
    ]) {
      const file = JSON.stringify({ ...base, theme: { ...base.theme, ...patch } });
      expect(importTheme(file, "x"), JSON.stringify(patch)).toEqual({
        ok: false,
        error: "invalid-field",
      });
    }
  });
});
