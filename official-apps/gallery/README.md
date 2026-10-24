# Gallery

Organize approved files and folders into up to 20 named albums. The app is an image index, not a
file manager: it never moves or deletes source files. Permissions are `files:pick` and `storage:app`.
The original locations remain protected by EveryOS's file grants.

Each album can include selected persistent image handles and up to 20 approved directory handles.
Folder scans use only relative paths beneath those handles. A scan stops at 1,000 images, 200
folders, 20,000 visited entries, depth 8 or 30 seconds. Unreadable/oversized entries or exhausted
limits produce an explicit partial result. Images above 50 MiB are excluded. The index is not
claimed complete after a failure, timeout or budget limit.

Search names/relative paths, sort by name/size/known modification time, toggle favorites, select
40-image pages and remove selected references. Directly selected files have unknown modification
time, never a fabricated current timestamp. Folder rescans preserve favorites for the same root
and relative path. The grid resolves at most four bridge operations concurrently, renders 40
thumbnails per page and shows unavailable previews explicitly. The shared Image Viewer surface
provides zoom, pan, rotation and slideshow without exporting or modifying images.

Storage is sharded: `gallery.v1` holds album ids/names and settings; `album/<id>` holds that
album's validated references, favorites, root ids and scan time. Each index is capped at 210 KiB
with a partial label, comfortably below the SDK's 256 KiB value ceiling. No image bytes or
capability URLs are persisted. Deleting an album locks its editor, flushes pending/in-flight
writes, then removes the key and album metadata. This prevents an unmount flush recreating it.
Share/permission changes fence reads, clear previews and recheck available handles; suspend stops
indexing/slideshows. Expiring URLs are renewed while the app is active.

Seven logic/interface tests cover path validation, budgets, partial scans, size bounds, search,
favorites, restore, revocation, bulk references and pending-edit deletion. The real-browser test
indexes a selected folder with nested images, excludes a neighboring image, checks real thumbnail
decoding, rescans, renames/restores an album, runs a mobile slideshow and verifies source files
still exist after reference/album deletion. All 60 locale keys are supplied in ten languages.

```bash
pnpm exec vitest run --project official-apps official-apps/gallery
```
