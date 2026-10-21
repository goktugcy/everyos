# Code Editor

EveryOS's code editor (`dev.everyos.code`), built on CodeMirror 6. It reaches only the files and
the folder you pick: there is no terminal and no other file system access.

## What it does

- **Workspace folder**: open a folder to browse it in the explorer. Folders load as you open
  them (up to 1,000 entries each; the rest are counted). With write access you can make new files
  and folders; names already in use are refused. The folder, and which subfolders were open, come
  back next time. The tree works with the keyboard: arrows move, Right and Left open and close
  folders, Enter opens a file.
- **Tabs**: any number of files, from the workspace or opened on their own, plus new untitled
  files. Unsaved tabs are marked; closing one asks first; closing the window with unsaved files
  asks first.
- **Nothing typed is lost**: unsaved text is kept as you type (and at once when the window goes
  to the background or closes) and comes back after a reload, still linked to its file.
- **Syntax highlighting** chosen from the file name, or picked in the status bar from the
  languages CodeMirror knows; completion of words and language keywords.
- **Search and replace** (Ctrl/⌘+F, with regular expressions, case and whole-word options), go to
  line (Ctrl/⌘+G), multiple cursors, bracket matching, code folding.
- **Minimap** next to the text (can be turned off).
- **Themes**: like EveryOS (follows light and dark), light, dark or high contrast. Font size, tab
  size, spaces or tabs, and line wrapping in the settings.
- **Save and open**: Ctrl/⌘+S saves in place, Save as asks where; Ctrl/⌘+O opens files, Ctrl/⌘+N
  starts a new one, Ctrl/⌘+B shows or hides the explorer. Files keep their line endings (LF or
  CRLF, switchable in the status bar) and their UTF-8 byte order mark. If the file changed on
  disk since you opened it, saving asks before replacing it.
- Only UTF-8 text is opened (up to 5 MB): binary files are refused, and so are files in other
  encodings, which the Text Editor reads and writes without changing their bytes.
- If EveryOS withdraws access to the folder, it closes; open tabs keep their text as unsaved
  copies that can be saved elsewhere.

## Permissions

| Capability    | Why                                                         |
| ------------- | ----------------------------------------------------------- |
| `storage:app` | Settings, the open folder, the tab list and unsaved text    |
| `files:pick`  | Opening files and a workspace folder                        |
| `files:save`  | Saving files, and making files and folders in the workspace |

## Storage

| Key         | Value                                                               |
| ----------- | ------------------------------------------------------------------- |
| `settings`  | Theme, font size, tab size, spaces or tabs, wrapping, minimap       |
| `workspace` | The workspace folder's file handle                                  |
| `expanded`  | Folders open in the explorer                                        |
| `sidebar`   | Whether the explorer is shown                                       |
| `tabs`      | Open tabs: names, where they come from, line endings, language      |
| `doc/<id>`  | Unsaved text of a tab, up to 100,000 characters (larger: link only) |

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/code
cd official-apps/code && pnpm exec everyos-app validate
```
