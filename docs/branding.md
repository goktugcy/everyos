# EveryOS identity and built-in wallpaper

EveryOS is presented as a self-hosted personal OS experience: a browser desktop for personal
files, applications and a workspace running on the owner's existing Linux installation.
The README leads with that experience; host-management internals are covered in the operating
and developer guides. Product copy must describe implemented capabilities and their setup
requirements, without implying that EveryOS supplies a bootable Linux distribution.

## Visual assets

The project owner supplied the desktop screenshot, mountain wallpaper and white wordmark.
They are included as local project assets without generated replacements. The README screenshot
uses the owner's updated English desktop capture, including the Pulse shelf.

| Asset              | Location                                           | Use                                         |
| ------------------ | -------------------------------------------------- | ------------------------------------------- |
| Color wordmark     | `apps/web/public/everyos.png`                      | Light-background README header              |
| White wordmark     | `apps/web/public/everyos-white.png`                | Dark-background README header               |
| Desktop screenshot | `docs/images/everyos-desktop.png`                  | README product overview                     |
| Mountain wallpaper | `apps/web/public/wallpapers/everyos-mountains.png` | Default background and downloadable artwork |

The README uses a `picture` element to select the wordmark for the reader's color scheme.
Wordmarks keep their original aspect ratio and clear space. The supplied screenshot shows
the owner's desktop; it is not a generated product mockup or a source of benchmark claims.

## Wallpaper behavior

`everyos-mountains` is a new built-in wallpaper preset, selectable in Settings → Appearance.
It is the default background for the Liquid Dark theme and the fallback for unavailable private
uploads in the desktop/mobile shells. Sign-in and setup use the same theme default. The image
is packaged with the web client and needs no remote image host, upload or authenticated API request.

Other built-in presets remain selectable. Explicit saved wallpaper choices and per-desktop
overrides still take precedence; no preferences or user uploads are rewritten. Accounts using
the default Liquid Dark background pick up the new default through theme resolution.

The mountain image is static in all rendering modes, with a centered `object-cover` fit. If the
bundled image fails to load, its matching CSS palette is used. Private-upload failure and
bundled-asset failure have separate state so one cannot restart the other's failed request.

The theme engine treats bundled images like uploaded photographs when computing readable glass
surfaces: pure white and pure black bound the possible backdrop. Sampling a few mountain colors
would miss the white wordmark and could make overlapping text unreadable.

These assets and defaults apply to builds from 0.1.1 onward. The earlier 0.1.0 packages remain
tied to their original tag and do not include the new wallpaper.

## Verification (2026-10-11)

- `pnpm typecheck` passed across the workspace. Affected TypeScript lint, formatting and diff
  checks passed.
- The existing theme and translation suites passed: 34 tests in two files. These include the
  static default, photographic contrast bounds and complete Turkish/English keys.
- `pnpm build` passed; `dist/web/wallpapers/everyos-mountains.png` matches the supplied asset.
- Two scoped existing browser cases passed: first-run setup and theme/render-mode persistence.
  They also verify pre-authenticated image loading, the desktop image's decoded width, missing
  asset fallback, selecting and persisting the new preset, and returning to an existing preset
  and the theme default.
- GitHub's Markdown rendering API retained the dark-mode wordmark source, desktop screenshot
  and expandable wallpaper section. All README local links and image paths resolve.

The full browser suite was not repeated for this change. Its three previously recorded CI
failures remain documented in [phase8-acceptance.json](phase8-acceptance.json).
