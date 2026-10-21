# Diff Viewer

EveryOS's text and file comparison (`dev.everyos.diff`). Both texts stay on this device; the app
has no network access.

## What it does

- **Compare text**: paste or type into the original and changed sides; the comparison updates as
  you edit either side. Changed words are marked inside changed lines.
- **Compare files**: open each side from your files (up to 5 MB, text only; binary files are
  refused). File names appear above each side. When the two files use different line endings
  (LF, CRLF, CR), a note says so: the comparison ignores them.
- **Side by side or inline**: two aligned editors, or one editor with the removed lines shown
  above the new ones. Narrow windows always use the inline view.
- **Ignore whitespace**: changes that only add, remove or move spaces, tabs, blank lines or line
  breaks are left out ("Only whitespace differs" when nothing else changed).
- **Hide unchanged lines**: long unchanged stretches fold away, keeping three lines of context;
  click a fold to open it. **Wrap lines** for prose.
- **Syntax highlighting** chosen from the file names (or picked by hand), for the languages
  CodeMirror knows.
- **Change navigation**: previous and next change buttons, F7 and Shift+F7; the toolbar shows
  which change you are on ("2 of 5") and the lines added and removed.
- **Export a patch**: copy or save a unified diff (`--- a/name`, `+++ b/name`, three lines of
  context) that `git apply` and `patch` accept. Patches always contain whitespace changes so
  they apply cleanly, and use LF line endings.
- **Swap sides** and **New comparison** (asks before clearing).

Very large, very different texts are compared approximately rather than freezing the window; the
toolbar says when that happens.

## Permissions

| Capability        | Why                                |
| ----------------- | ---------------------------------- |
| `storage:app`     | The two sides and the view options |
| `clipboard:write` | Copying a patch                    |
| `files:pick`      | Opening the files to compare       |
| `files:save`      | Saving a patch                     |

## Storage

| Key                | Value                                                            |
| ------------------ | ---------------------------------------------------------------- |
| `left`, `right`    | Each side's text, file name and line endings, while under 240 KB |
| `mode`             | Side by side or inline                                           |
| `ignoreWhitespace` | Whether whitespace changes are ignored                           |
| `collapse`         | Whether unchanged lines are hidden                               |
| `wrap`             | Whether long lines wrap                                          |
| `language`         | Automatic, plain text or a language name                         |

A side larger than 240 KB is not kept after the window closes (app storage holds values up to
256 KB); the side's header says "Not kept".

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/diff
cd official-apps/diff && pnpm exec everyos-app validate
```
