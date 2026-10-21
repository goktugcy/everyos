# Markdown Editor

EveryOS's Markdown editor (`dev.everyos.markdown`): a highlighting editor with a live preview, an
outline, search and replace, and Markdown and HTML export.

## What it does

- **Editor, split or preview** (Mod+E switches; narrow windows show one at a time). The editor
  highlights Markdown and the code in fenced blocks; the preview renders tables, task lists,
  links and code colored by language. Raw HTML in the text is shown as text, never run.
- **Search and replace** with regular expressions, case and whole words (Mod+F).
- **Outline** of the headings: choosing one moves the editor and the preview there.
- **Files** through the EveryOS file picker: open `.md`, `.markdown` or `.txt`, Save writes back
  to the opened file, Save as asks for a place; recent files stay listed. Leaving or closing with
  unsaved changes asks first.
- **Autosave and recovery.** The document is kept in the app's storage as you type and comes
  back after a reload or a crash (up to 200,000 characters; longer texts say so and need saving).
- **Export** Markdown, or a standalone HTML page (its own light/dark stylesheet, no scripts);
  copy the rendered HTML.
- Word and character counts and reading time.

Shortcuts: Mod+N new, Mod+O open, Mod+S save, Mod+Shift+S save as, Mod+F find, Mod+E view.

## Permissions

| Capability        | Why                                      |
| ----------------- | ---------------------------------------- |
| `storage:app`     | The draft for recovery, and the settings |
| `files:pick`      | Opening the files you choose             |
| `files:save`      | Saving and exporting where you choose    |
| `clipboard:write` | Copy HTML                                |

## Storage

| Key        | Value                                                       |
| ---------- | ----------------------------------------------------------- |
| `draft`    | The document: name, file link, text and the text last saved |
| `settings` | View and whether the outline shows                          |

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/markdown
cd official-apps/markdown && pnpm exec everyos-app validate
```
