# Text Editor

EveryOS's plain text editor (`dev.everyos.text`): several files in tabs, find and replace,
encodings and line endings, and recovery of unsaved work.

## What it does

- **Tabs**: new, open several files at once, switch (click or ←/→ on the tabs), close (asks when
  there are unsaved changes). A dot marks unsaved changes; closing the window with unsaved files
  asks first.
- **Files** through the EveryOS file picker: Save writes back to the opened file, Save as asks for
  a place; the files you open stay available under _Recent files_.
- **Find and replace** (Mod+F, regular expressions, case, whole words), **go to line** (Mod+G),
  line numbers and word wrap (toggles in the status bar, remembered).
- **Encodings.** A byte order mark decides; otherwise strict UTF-8; otherwise the legacy encoding
  of your language (Windows-1254 for Turkish, Windows-1251 for Russian, Shift_JIS, EUC-KR,
  GB18030, else Windows-1252). _Reopen with encoding_ fixes a misread file. Files are saved in
  their encoding: UTF-8 (with or without a byte order mark), UTF-16 LE/BE or a single-byte code
  page. A character the encoding cannot hold is never dropped: saving stops and says which one,
  on which line. Shift_JIS, EUC-KR and GB18030 are read only; such files are saved as UTF-8 (the
  app says so).
- **Line endings** LF, CRLF or CR are detected and kept, or converted from the status bar.
- **Recovery.** Every tab and its unsaved text are kept as you type and come back after a reload
  or a crash. Texts above 100,000 characters keep only their file link (recovery copies are
  limited by storage).
- Binary files and files above 10 MB are refused with an explanation.

Shortcuts: Mod+N new, Mod+O open, Mod+S save, Mod+Shift+S save as, Mod+W close tab, Mod+F find,
Mod+G go to line.

## Permissions

| Capability    | Why                                                |
| ------------- | -------------------------------------------------- |
| `storage:app` | Open tabs, recovery copies and the editor settings |
| `files:pick`  | Opening the files you choose                       |
| `files:save`  | Saving to the opened file or a place you choose    |

## Storage

| Key        | Value                                                        |
| ---------- | ------------------------------------------------------------ |
| `tabs`     | The open tabs (name, file link, encoding, line endings)      |
| `doc/<id>` | A tab's text while it differs from its file (or has no file) |
| `settings` | Line numbers and word wrap                                   |

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/text
cd official-apps/text && pnpm exec everyos-app validate
```
