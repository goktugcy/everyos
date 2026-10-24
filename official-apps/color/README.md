# Color Studio

EveryOS's color tool (`dev.everyos.color`). It picks and converts colors, builds palettes,
harmonies and gradients, checks contrast, and shows a color next to the current EveryOS theme. It
has no network access.

## What it does

- **Pick** on a saturation/brightness square with hue and alpha sliders, using the pointer or the
  keyboard (arrows; Shift for larger steps). Where the browser supports it, the eyedropper picks
  any color on screen.
- **Enter or copy any format**: HEX (3, 4, 6 or 8 digits), `rgb()`, `hsl()`, `oklch()` and CSS
  color names. Each field accepts any of these formats, and other fields update as you type.
  Written values read back to the same color.
- **Palettes**: harmonies (complementary, analogous, triadic, split complementary, tetradic,
  monochromatic) in OKLCH so lightness stays even, and a tonal 50–950 scale with CSS variables to
  copy. Both can be saved as palettes.
- **Gradients**: linear or radial, an angle, and up to eight stops with positions. The CSS is
  ready to copy.
- **Contrast**: WCAG 2 ratio for a text and background pair, with AA/AAA results for normal and
  large text and a live sample. Translucent text is blended over its background first.
- **Saved palettes**: name them, add the current color, remove colors, and copy or save them as a
  CSS file of custom properties.
- **EveryOS theme**: the theme's own colors (accent, text, surfaces, states) for the current
  scheme, and the color as a button, link and toggle on light and dark surfaces, with the link's
  contrast.

## Permissions

| Capability        | Why                                |
| ----------------- | ---------------------------------- |
| `storage:app`     | Current color, palettes and panels |
| `clipboard:write` | Copying colors, variables and CSS  |
| `files:save`      | Saving a palette as a CSS file     |

## Storage

| Key        | Value                                  |
| ---------- | -------------------------------------- |
| `color`    | The current color (HEX)                |
| `panel`    | The open panel                         |
| `harmony`  | The chosen harmony                     |
| `gradient` | Kind, angle and stops of the gradient  |
| `contrast` | The text and background being compared |
| `palettes` | Saved palettes (name and HEX colors)   |

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/color
cd official-apps/color && pnpm exec everyos-app validate
```
