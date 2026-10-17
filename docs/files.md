# File manager (Phase 7)

Trash uses a shared, permissioned listing of the current account's recoverable files. Its icon
changes between an empty bin and a bin with visible paper in the desktop, Dock, launcher,
window title and Files sidebar. File mutations refresh it immediately; visible sessions also
poll every ten seconds for changes from another tab. Loading, failed or incomplete empty
listings show an unknown-state icon rather than claiming the bin is empty. The same listing
feeds the Trash window and is discarded when the session changes.

Desktop shortcuts, files and installed applications highlight the whole item, including its icon
and name, with one selection background and outline. The Applications home entry uses the same
whole-item focus feedback; file-list and Trash selections continue to highlight their rows.
Names have no separate colored plate. Captions wrap unbroken names and shrink based on measured width
and loaded fonts, down to 9px within three lines. Names exceeding that readable space expand in
full when selected, hovered or keyboard-focused; the full title and accessible name remain intact.
Mobile launcher names use the same fitting component. Icon layout and drag/selection hit areas
retain their existing geometry.

The file manager never exposes the host file system by default. Every user gets a private
**home** inside EveryOS's data directory; an administrator configures shared **locations** in
`/etc/everyos/config.yaml`; and read-only **system** locations exist only after an administrator
turns them on. Nothing else is reachable.

```yaml
files:
  roots:
    - { id: media, name: Medya, path: /srv/media }
    - { id: backups, name: Yedekler, path: /var/backups/everyos, readOnly: true }
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
deleted (`FILES_PROTECTED`), and a folder removed outside EveryOS is created again. Their contents
are the user's. Existing homes, including their Desktop files and private trash, are included
in every backup ([backups.md](backups.md)). The folder-name manifest is protected against writes
and unsafe path components, including changes through symlink aliases.

### System locations

Administrators (`system:manage`) can show read-only Linux locations in the sidebar's System
section: `/` (Computer), `/home`, `/etc`, `/var/log`, `/srv`, `/mnt`, `/media` and `/opt` — only
those that exist. They are off until an administrator turns them on (with a confirmation;
`PUT /api/files/settings { systemRoots }`, audited as `files.settings`) and other roles never see
them. They are always read-only, they are read with the API user's own permissions (so for example
`/etc/shadow` stays unreadable), and the kernel's pseudo file systems `/proc`, `/sys` and `/dev`
are never listed, opened or searched through `/`.

### Disks

Disks an administrator mounts in Settings › Disks appear in the sidebar's **Disks** section, named
by their label (else their UUID), as locations of kind `disk` with id `disk-<uuid>`. In production
they are found in the account worker's mount table and used with the linked Linux account's
permissions, like other host locations. The free-space reserve (`minFreeMiB`) protects the
system's filesystem and does not apply on a disk. Plugged-in disks that are not mounted are listed
too, with a mount button for administrators, and mounted ones have an eject button. See
[disks.md](disks.md).

### Google Drive

A person who connected their Google Drive finds it under **Cloud** in the sidebar: browse My Drive
and Shared with me, upload from the computer, download, rename, move to Drive's trash, and copy
between Drive and EveryOS locations. **Send to Google Drive…** on local items copies them up. See
[drive.md](drive.md); copies are [transfers](transfers.md) with live progress.

Development mode adds a sandbox root (`<dev root>/files`). Production has no roots until
they are configured, and `/api/files/*` then answers `FILES_DISABLED`.

## Identity and path safety

File operations run in the **API process as its unprivileged user**, not in the root agent. So
the operating system remains the final boundary: even a path trick could only reach what the
`everyos` user may access anyway. Grant that user access to data folders with normal permissions
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
| `POST /files/{mkdir,rename,copy,move,delete}` | `files:write` | Copy keeps symlinks as symlinks. Moves across file systems copy then delete. Delete needs `confirm: true`, moves to private trash and never targets a root.            |

Read-only roots refuse writes with `FILES_READ_ONLY`. A full disk returns
`FILES_INSUFFICIENT_SPACE` (507). Every change is audited (`files.mkdir`, `files.upload`,
`files.write`, `files.create`, `files.rename`, `files.copy`, `files.move`, `files.delete`).

## Desktop app

The **Files** app (`everyos.files`) looks like the macOS Finder and provides:

- **Navigation:** a sidebar with Favourites (the home and its standard folders, always present),
  Locations and, for administrators, System; back/forward/up; the folder's name as the title;
  and a path bar at the bottom.
- **Views:** icons (the default, with thumbnails for images up to 8 MiB and glyphs on the
  standard folders) or a list with sortable columns, folders first; each window remembers its
  choice.
- **Search and selection:** search; multi-selection with Ctrl/Cmd and Shift; drag an empty area
  to draw a selection rectangle in both icon and list views (Shift adds, Ctrl/Cmd toggles);
  Escape clears selection; keyboard actions
  (arrows, Enter, Backspace, Delete, F2, Ctrl+A/C/X/V).
- **Context menus:** open, download, cut, copy, paste, rename, duplicate, copy path, properties,
  delete; on the background also the view and **Open Terminal** (with `terminal:access`, a new
  Terminal window; it does not start in the folder yet). The desktop's context menu has Open
  Terminal too.
- **Drag and drop** onto folders, the path bar or sidebar places: move, or copy with Alt/Ctrl.
- **Uploads:** files dropped from the operating system or chosen in a picker upload with progress,
  and ask before replacing an existing file.
- **Previews and editing:** images open in a preview. Text files open in the **Text Editor**
  (`everyos.editor`), which saves with Ctrl+S, detects concurrent changes and can revert.
- Every change made in the tab (any Files window, the desktop, the pulse shelf) makes all views
  of a folder list it again.

## The desktop is the Desktop folder

The **Applications** system folder opens a live icon view of Store-managed installations.
It appears in Favorites and beside the ordinary files in the user's home in both icon and list
views. It opens inside Files with its own application search and lifecycle controls, preserving
the window location across reloads. Back and the home breadcrumb return to the home view.
It is a launcher collection, separate from ordinary home files; an identically named physical
folder remains independent and container data remains in its managed project. File deletion,
rename, clipboard and drops never operate on the collection. See
[app-store.md](app-store.md#applications-folder) for launch and selection.

Like macOS, the desktop shows the contents of the home's **Desktop** folder (on every virtual
desktop) next to the app shortcuts. Its items are ordinary files and folders:

- **New folder** and **New text document** in the desktop's context menu create them in the
  Desktop folder, where the menu was opened; **Paste** pastes the Files clipboard there and
  **Open Desktop folder** opens it in Files.
- **Opening** works as in Files: a folder opens in a Files window (with the sidebar), an image in
  the preview, a text file in the Text Editor, anything else downloads.
- **Item menus and keys:** open, download, show in Files, cut, copy, paste into a folder, rename
  (F2), properties, move to trash (Delete, with confirmation). Ctrl/Command-click toggles icons, Shift-click
  selects a range, Ctrl/Command+A selects all and Escape clears the selection. Drawing on empty
  desktop space selects intersecting icons in either direction; Shift adds and Ctrl/Command toggles
  that area. Selected files cut, copy, move and go to trash together. Shortcuts are removed only
  from the desktop; their apps are never uninstalled.
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

## Recoverable trash

Normal deletion in Files and on the desktop moves data by rename into
`<root>/.otuken-trash/<userId>/<itemId>/item`, with private `info.json` recording the original
relative path, name, type, size and deletion time. Directories are private, metadata is synced
before moving, and symlinks move as links. Parent/child and duplicate selections are collapsed.
A cross-device rename fails safely with the original intact; no copy-and-delete fallback is used.
The trash consumes disk space until explicitly emptied. On filesystems without Unix permissions
(FAT, exFAT and NTFS USB disks) every directory has the modes the mount gives it, so the trash
there cannot be private by mode; it still belongs to the account, like every file on that disk.

The **Trash** app (`everyos.trash`) opens from the launcher, the Files sidebar or desktop context
menu. Each account sees only its own trash, including on shared roots. Restoring refuses an
occupied original name or a missing/escaping original parent; files use an exclusive hard-link
or exclusive-copy fallback, and folders reserve their names before moving back. Multi-item
operations may partially succeed; views refresh to show the actual remaining items.
Permanent deletion and emptying require a separate confirmation. Read-only roots cannot be
restored or emptied, and every mutation needs `files:write` and is audited.

Trash artwork is a transparent metallic wire basket, without an opaque app tile. Empty and
paper-filled variants share the current account's permissioned listing across the desktop,
dock, launcher and Files sidebar. A failed or truncated-empty listing retains an unknown
indicator instead of pretending the basket is empty.

Right-click the Trash icon on the desktop, dock or Files sidebar to **Empty trash**.
This action confirms permanent deletion of the account's entire recoverable trash, including
folder contents across configured roots. It fetches a fresh listing, uses existing permissioned
and audited deletion requests in batches of at most 500, and continues through truncated listings.
Concurrent empty requests are disabled; changing sessions, locking or losing file permissions stops
further batches. Failures refresh the real state and show a dismissible error. Incomplete listings
that cannot advance are reported rather than treated as empty. A known-empty bin disables the action.

`.otuken-trash` is inaccessible to ordinary list, search, download, text, transfer and mutation
routes even when hidden files are shown, including symlink aliases. It is storage owned by
EveryOS, not an implementation of the host OS's Trash or the freedesktop Trash specification.

| Endpoint                    | Permission    | Input / result                                                     |
| --------------------------- | ------------- | ------------------------------------------------------------------ |
| `GET /files/trash`          | `files:read`  | `{ entries, truncated }`; private entries across configured roots  |
| `POST /files/trash/restore` | `files:write` | `{ root, ids }`, at most 500 UUIDs                                 |
| `POST /files/trash/delete`  | `files:write` | `{ root, ids, confirm: true }`, permanently deletes selected items |

Audit actions are `files.delete` with `mode: "trash"`, `files.trash.restore` and
`files.trash.delete`; contents are never written into audit details. Validated requests are
also audited when a batch stops after a partial change, with `succeeded: false`.

## Linked Linux identities

See [Linux account linking](linux-accounts.md). EveryOS personal storage keeps its existing
API-owned homes and backup coverage; host locations and Linux homes use the linked account’s
actual UID, groups and ACLs. Privileged system actions require verified existing sudo rights.
