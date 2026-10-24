# JSON Studio

EveryOS's JSON tool (`dev.everyos.json`): an editor that validates as you type, a tree to explore
large documents, JSONPath queries, a structural comparison and CSV export.

## What it does

- **Editor** with JSON highlighting. Errors are underlined and named in the status bar with their
  line and column (trailing commas, missing commas or colons, single-quoted keys, bad escapes,
  control characters in strings, text after the value …); clicking the message moves there.
- **Format** with 2 or 4 spaces or tabs, optionally sorting keys (Mod+Shift+F), **minify**, copy,
  open and save files.
- **Tree** of the document: expand and collapse with the mouse or the arrow keys, see types and
  sizes, copy a value or its JSONPath. Only the visible rows are drawn, so documents of several
  megabytes stay responsive. Search finds keys and values and opens the way to each match.
- **JSONPath** queries (a documented subset, evaluated without code execution): `$.a.b`,
  `$['a b']`, `[0]`, `[-1]`, `[0,2]`, `[1:3]`, `[::-1]`, `*`, `..name`, `..*`,
  `[?(@.price < 10)]` (==, !=, <, <=, >, >= with numbers, strings, true, false, null),
  `[?(@.isbn)]` and `.length`. Results can be shown in the tree or copied.
- **Compare** with another document (pasted or opened): members are matched by key, elements by
  position; added, removed and changed paths are listed with their values.
- **CSV** from an array: the union of the rows' keys becomes the columns (nested objects as dot
  paths, arrays as JSON), quoted as RFC 4180 requires; preview, copy or export.
- The document is kept as you type and comes back after a reload (up to 200,000 characters).

## Permissions

| Capability        | Why                                   |
| ----------------- | ------------------------------------- |
| `storage:app`     | The document, settings and last query |
| `files:pick`      | Opening JSON files you choose         |
| `files:save`      | Saving JSON and exporting CSV         |
| `clipboard:write` | Copying JSON, paths, results and CSV  |

## Storage

| Key        | Value                                     |
| ---------- | ----------------------------------------- |
| `draft`    | The document's text and name              |
| `settings` | Indentation, key sorting and the open tab |
| `query`    | The last JSONPath query                   |
| `compare`  | The document to compare with              |

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/json
cd official-apps/json && pnpm exec everyos-app validate
```
