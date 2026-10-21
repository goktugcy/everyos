# Notes

EveryOS's Markdown notes app (`dev.everyos.notes`), and the reference for official apps built with
`@everyos/app-ui`.

## What it does

- Notes in Markdown, with an editor, a rendered preview or both side by side (⌘/Ctrl+E switches).
  Task lists (`- [ ]`), tables, code and links render; raw HTML in a note is shown as text, never
  run.
- Folders, tags (`#tag` in search), pinned notes on top, sorting by last edit, creation or title.
- Search across titles, tags and the full text of every note.
- Saving as you type (and always before the window closes, goes to the background or opens another
  note), with up to 20 earlier versions per note to read and restore.
- Recently deleted: deleted notes can be restored for 30 days, then are removed with their versions.
- Import `.md`, `.markdown` and `.txt` files (each becomes a note) and Notes backups (`.json`);
  export a note as Markdown or every note as a backup.
- The **Quick note** widget (desktop and sidebar) adds a note without opening the app and opens the
  recent ones.

Shortcuts: ⌘/Ctrl+N new note, ⌘/Ctrl+F search, ⌘/Ctrl+E view, ⌘/Ctrl+S save now, ⌘/Ctrl+Shift+P
pin. Tab indents in the editor.

## Permissions

| Capability         | Why                                                    |
| ------------------ | ------------------------------------------------------ |
| `storage:app`      | The notes, kept per person in EveryOS (the widget too) |
| `files:pick`       | Importing files the person picks                       |
| `files:save`       | Exporting to a place the person chooses                |
| `clipboard:write`  | Copy Markdown                                          |
| `widgets:register` | The Quick note widget                                  |

Notes has no network access and sees no file it was not handed.

## Storage

| Key              | Value                                                         |
| ---------------- | ------------------------------------------------------------- |
| `index/0` … `7`  | Note metadata (title, excerpt, folder, tags, dates), by shard |
| `body/<id>`      | A note's Markdown (at most 200,000 characters)                |
| `revisions/<id>` | Earlier versions, newest first                                |
| `folders`        | Folder names                                                  |
| `settings`       | Sort order and view                                           |
| `widget/draft`   | What is typed in the widget and not added yet                 |

A backup (`format: "everyos-notes/1"`) holds the folders and every note that is not deleted, with
its text. Importing it adds the notes that are not there yet (by id).

## Development

```bash
pnpm exec everyos-app dev        # the mock desktop
pnpm exec everyos-app validate   # build and check like EveryOS
pnpm exec vitest run --project official-apps official-apps/notes
```
