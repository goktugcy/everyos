# PDF Viewer

EveryOS's PDF reader (`dev.everyos.pdf`), built on [pdf.js](https://mozilla.github.io/pdf.js/).
Documents are read on this device: pdf.js parses them in a worker inside the app's sandbox, and
the app has no network access.

## What it does

- **Open PDF files** you pick (up to 200 MB). Password-protected documents ask for their
  password. Damaged files and files that are not PDFs say so.
- **Pages**: continuous scrolling with crisp text you can select and copy; previous and next page
  buttons; type a page number to jump to it. Links inside the document work; links to the web
  open in a new tab. Form fields can be filled in.
- **Thumbnails** of every page in the sidebar (drawn as they scroll into view).
- **Zoom**: automatic, page width, whole page, actual size, or 50 % to 400 %; zoom in and out
  with Ctrl/⌘ + = and Ctrl/⌘ + −, Ctrl/⌘ + 0 for automatic.
- **Rotate** the view left or right (the page stays in view).
- **Search** the text (Ctrl/⌘+F): all matches highlighted, next and previous (Enter,
  Shift+Enter), match case, whole words, with the count of matches.
- **Outline**: the document's own table of contents, as a tree.
- **Bookmarks**: mark pages, name them, jump back to them.
- **Print** (Ctrl/⌘+P): every page is drawn at 150 dpi for the browser's print dialog, one page per
  sheet, as shown (rotated or not).
- **Save a copy** (Ctrl/⌘+S) where you choose, with filled-in form fields when there are any.
- **Picks up where you left off**: each document (recognised by its content, not its name) reopens
  at the same page, zoom and rotation, with its bookmarks. Recent documents are listed on the
  start screen.

## Permissions

| Capability    | Why                                                       |
| ------------- | --------------------------------------------------------- |
| `storage:app` | Recent documents, and each document's place and bookmarks |
| `files:pick`  | Opening PDF files                                         |
| `files:save`  | Saving a copy                                             |

## Storage

| Key       | Value                                                              |
| --------- | ------------------------------------------------------------------ |
| `recent`  | The last 12 documents: file handle, name, fingerprint, when opened |
| `doc/<f>` | Per document (pdf.js fingerprint): page, zoom, rotation, bookmarks |
| `sidebar` | Whether the sidebar is shown, and its tab                          |

## Third-party components

pdf.js (Apache-2.0) with its data files, copied into the package by `assets` in
`everyos.config.json` together with their licences (`pdfjs/**/LICENSE*.txt`): Adobe character
maps; Foxit (BSD) and Liberation (SIL OFL) standard fonts; the OpenJPEG (BSD-2-Clause), PDFium
JBIG2 (BSD) and qcms (MIT) decoders compiled to WebAssembly; a CC0 colour profile.

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/pdf
cd official-apps/pdf && pnpm exec everyos-app validate
```

The interface is tested against a fake engine (`test/app.test.tsx`); rendering, search, the outline,
rotation, printing and reopening run against pdf.js in a real browser in
`tests/e2e/official-apps.spec.ts`.
