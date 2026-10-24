# Whiteboard

EveryOS's whiteboard (`dev.everyos.whiteboard`), built on [Excalidraw](https://excalidraw.com)
(MIT). Drawings stay in EveryOS; the app has no network access and loads nothing from the web.

## What it does

- **Infinite canvas** with Excalidraw's tools: selection, rectangle, diamond, ellipse, arrow and
  line (arrows connect to shapes and follow them), pen (free drawing), text, eraser and the
  laser pointer; styles, layers, grouping, alignment, frames, and diagrams from Mermaid text.
- **Undo and redo**, **zoom and pan** (wheel, gestures, keyboard), and Excalidraw's keyboard
  shortcuts (press `?` for the list).
- **Boards**: as many as you like, each with a name; new, rename, duplicate, delete. The board
  saves itself a moment after each change, and a drawing made just before the window closes is
  kept too. Boards up to 12 MB (compressed) are kept; larger ones say so and can be saved as a
  file.
- **Export** the board as **PNG** or **SVG** (both carry the drawing inside, so they can be
  imported again) or as an Excalidraw board file (`.excalidraw`), saved where you choose.
- **Import** boards from `.excalidraw` or Excalidraw JSON files, or from PNG and SVG files exported
  with the drawing inside; each becomes a new board.
- Your **shape library** (Excalidraw's library panel) is kept.
- Follows the EveryOS theme (light and dark) and language.

Pictures cannot be inserted from the browser's own file chooser (apps reach files only through
EveryOS's picker); pictures in imported boards are kept.

## Permissions

| Capability    | Why                                           |
| ------------- | --------------------------------------------- |
| `storage:app` | Boards, the shape library, the open board     |
| `files:pick`  | Importing boards                              |
| `files:save`  | Exporting boards as PNG, SVG or `.excalidraw` |

## Storage

| Key                  | Value                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| `boards`             | Each board's name, dates and stored size                                    |
| `board/<id>/<n>`     | A board's drawing: gzip-compressed Excalidraw JSON, in chunks               |
| `stash`, `stash/<n>` | A drawing written while the window closed, saved properly at the next start |
| `library`            | The shape library (compressed)                                              |
| `current`, `sidebar` | The open board, whether the board list is shown                             |

## Third-party components

Excalidraw 0.18.1 (MIT), with its fonts copied into the package by `assets` in
`everyos.config.json`. EveryOS patches it (`patches/@excalidraw__excalidraw@0.18.1.patch`) so that
fonts never fall back to a CDN. Excalidraw's in-browser glyph subsetting needs `eval`, which apps
may not use, so SVG exports carry the whole font files they use.

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/whiteboard
cd official-apps/whiteboard && pnpm exec everyos-app validate
```

The interface is tested against a stand-in canvas; Excalidraw itself (drawing, keeping a board
across a closed window, SVG and PNG export) runs in a real browser in
`tests/e2e/official-apps.spec.ts`.
