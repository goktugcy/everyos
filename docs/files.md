# File manager (Phase 7)

The file manager never exposes the host file system by default. Every user gets a private
**home** inside Otuken's data directory; an administrator configures shared **locations** in
`/etc/otuken/config.yaml`; and read-only **system** locations exist only after an administrator
turns them on. Nothing else is reachable.

```yaml
files:
  roots:
    - { id: media, name: Medya, path: /srv/media }
    - { id: backups, name: Yedekler, path: /var/backups/otuken, readOnly: true }
  maxUploadMiB: 16384 # default 16 GiB per file
  minFreeMiB: 1024 # uploads and copies always leave this much free space
  homes: true # private home folders under <dataDir>/homes (default)
```

### Homes

Each user's home is `<dataDir>/homes/<user id>` (mode 0700, owned by the API user), addressed as
the root `home`: a request can only ever reach the caller's own home, so homes are private even
from administrators in the app. On first use it gets the standard folders **Desktop, Documents,
Downloads, Pictures, Music and Videos**, named in the user's language at that moment
("Masaüstü, Belgeler, İndirilenler, Resimler, Müzik, Videolar" in Turkish) and recorded in
`.otuken-folders.json`. A standard folder added by a later version is named in the user's
current language; existing names never change. They are fixed: they cannot be renamed, moved or
deleted (`FILES_PROTECTED`), and a folder removed outside Otuken is created again. Their contents
are the user's. Homes are not part of backups yet.

### System locations

Administrators (`system:manage`) can show read-only Linux locations in the sidebar's System
section: `/` (Computer), `/home`, `/etc`, `/var/log`, `/srv`, `/mnt`, `/media` and `/opt` — only
those that exist. They are off until an administrator turns them on (with a confirmation;
`PUT /api/files/settings { systemRoots }`, audited as `files.settings`) and other roles never see
them. They are always read-only, they are read with the API user's own permissions (so for example
`/etc/shadow` stays unreadable), and the kernel's pseudo file systems `/proc`, `/sys` and `/dev`
are never listed, opened or searched through `/`.

Development mode adds a sandbox root (`<dev root>/files`). Production has no roots until
they are configured, and `/api/files/*` then answers `FILES_DISABLED`.

## Identity and path safety

File operations run in the **API process as its unprivileged user**, not in the root agent. So
the operating system remains the final boundary: even a path trick could only reach what the
`otuken` user may access anyway. Grant that user access to data folders with normal permissions
(group membership, ACLs).

Every request uses `{ root, path }`, where `path` is relative to the root:

- **Rejected inputs:** absolute paths, `.` and `..` segments, NUL bytes, and names longer than
  255 bytes return `400`.
- **Resolution:** existing items are resolved with `realpath`, and the result must stay inside
  the root's canonical path. Anything else answers `404` exactly like a missing file, so nothing
  about the host leaks.
- **Links and new items:** for new items and operations on an entry itself (rename, delete, move,
  copy), only the parent is resolved. The final component is never followed: deleting a link
  deletes the link, never its target.
- **Opening files:** reads and writes open the final component with `O_NOFOLLOW` and check that
  it is a regular file.
- **Listings** show symlinks with their status (inside the root or not). Links pointing outside
  the root can never be opened. Search never descends into symlinked folders.

Remaining risk: a component swapped for a symlink between the check and the use (time-of-check
to time-of-use). The impact is limited to what the API user can reach anyway.

## Operations

| Endpoint                                      | Permission    | Notes                                                                                                                                                                  |
| --------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /files/roots`                            | `files:read`  | Roots, availability, read-only state.                                                                                                                                  |
| `GET /files/list?root&path&hidden`            | `files:read`  | Up to 5,000 entries (`truncated` otherwise); hidden files on request.                                                                                                  |
| `GET /files/properties`                       | `files:read`  | Type, size, times, permissions, owner/group names, child count, link status.                                                                                           |
| `GET /files/search?root&path&q`               | `files:read`  | Case-insensitive name search; 300 results, 50,000 entries, depth 16, 8 s.                                                                                              |
| `GET /files/text`                             | `files:read`  | UTF-8 text up to 1 MiB with an `etag`; binary or invalid UTF-8 → `FILES_NOT_TEXT`.                                                                                     |
| `GET /files/download?root&path&inline`        | `files:read`  | Streamed, `Range` support. Always `attachment` with `application/octet-stream`, except raster images with `inline=true`. Sandbox CSP.                                  |
| `PUT /files/text`                             | `files:write` | `etag: null` creates (fails if it exists). A stale `etag` returns `409`. Own files are replaced atomically; others' files are written in place to keep owner and mode. |
| `POST /files/upload?root&path&name&overwrite` | `files:write` | Raw body, `Content-Length` required, streamed to a temporary file and linked into place (no silent overwrite). Checks size limit and free space.                       |
| `POST /files/{mkdir,rename,copy,move,delete}` | `files:write` | Copy keeps symlinks as symlinks. Moves across file systems copy then delete. Delete needs `confirm: true` and never targets a root.                                    |

Read-only roots refuse writes with `FILES_READ_ONLY`. A full disk returns
`FILES_INSUFFICIENT_SPACE` (507). Every change is audited (`files.mkdir`, `files.upload`,
`files.write`, `files.create`, `files.rename`, `files.copy`, `files.move`, `files.delete`).

## Desktop app

The **Files** app (`otuken.files`) looks like the macOS Finder and provides:

- **Navigation:** a sidebar with Favourites (the home and its standard folders, always present),
  Locations and, for administrators, System; back/forward/up; the folder's name as the title;
  and a path bar at the bottom.
- **Views:** icons (the default, with thumbnails for images up to 8 MiB and glyphs on the
  standard folders) or a list with sortable columns, folders first; each window remembers its
  choice.
- **Search and selection:** search; multi-selection with Ctrl/Cmd and Shift; keyboard actions
  (arrows, Enter, Backspace, Delete, F2, Ctrl+A/C/X/V).
- **Context menus:** open, download, cut, copy, paste, rename, duplicate, copy path, properties,
  delete; on the background also the view and **Open Terminal** (with `terminal:access`, a new
  Terminal window; it does not start in the folder yet). The desktop's context menu has Open
  Terminal too.
- **Drag and drop** onto folders, the path bar or sidebar places: move, or copy with Alt/Ctrl.
- **Uploads:** files dropped from the operating system or chosen in a picker upload with progress,
  and ask before replacing an existing file.
- **Previews and editing:** images open in a preview. Text files open in the **Text Editor**
  (`otuken.editor`), which saves with Ctrl+S, detects concurrent changes and can revert.
- Every change made in the tab (any Files window, the desktop, the pulse shelf) makes all views
  of a folder list it again.

## The desktop is the Desktop folder

Like macOS, the desktop shows the contents of the home's **Desktop** folder (on every virtual
desktop) next to the app shortcuts. Its items are ordinary files and folders:

- **New folder** and **New text document** in the desktop's context menu create them in the
  Desktop folder, where the menu was opened; **Paste** pastes the Files clipboard there and
  **Open Desktop folder** opens it in Files.
- **Opening** works as in Files: a folder opens in a Files window (with the sidebar), an image in
  the preview, a text file in the Text Editor, anything else downloads.
- **Item menus and keys:** open, download, show in Files, cut, copy, paste into a folder, rename
  (F2), properties, delete (Delete, with a confirmation; deleting is permanent).
- **Dragging:** items drag onto desktop folders, into Files windows, sidebar places and the
  pulse shelf (move, or copy with Alt/Ctrl). Files dragged from a Files window or the computer
  onto the desktop move or upload into the Desktop folder (uploads never overwrite: a taken name
  gets a number). Dragging an item to an empty spot only rearranges it.
- **Places:** new items fill from the top right. Where each item sits is stored by name in the
  `desktop` preference (`files`, at most 500), kept on rename, and forgotten when the item is gone.
  The desktop lists the folder again after every change in the tab, on focus and every 20 s while
  visible; it shows at most 300 items.
- Without `files:read` (or with homes turned off) the desktop has only shortcuts; without
  `files:write` its items cannot be changed.

App groups ("folders" of shortcuts) from earlier versions are converted once: each becomes a real
folder of the same name in the Desktop folder, at the same place, and its shortcuts go back onto
the desktop. Without file access only the shortcuts are kept.

Not yet supported: uploading whole folders from the browser, archive downloads of folders, and
editing files larger than 1 MiB.
