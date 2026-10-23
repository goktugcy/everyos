# Disk Explorer

Disk Explorer (`dev.everyos.disk`) measures real files inside a folder the person explicitly
shares through the EveryOS folder picker. The persistent, read-only handle and relative location
are restored when the app reopens. Navigation stays inside that handle; revoked or unavailable
shares close the result. There is no arbitrary host-path input or unrestricted filesystem scan.
Permission changes hide protected snapshots and fence late results.

`disk.usage` supplies logical file lengths, directory totals, descendant counts, the 50 largest
files and the 50 largest extension groups. Extensions come from names, not content inspection.
The directory table shows size bars, search and 100-row pages; reports include all collected rows.
The server visits at most 50,000 entries and 32 nested levels and checks a 15-second deadline
between entries. File listings also have their own provider timeouts and 5,000-entry limit.
Symbolic links are not followed. Unreadable descendants and exhausted budgets produce a prominent
partial-result warning: sizes are lower bounds and those folder scans do not enter trend history.
An unreadable chosen root fails the call. Failed refreshes preserve the previous result with its
original measurement time and an explicit stale-data notice.

`system.storage` independently reports mounted filesystems, total capacity, used/available space,
filesystem type, device, read-only state and inodes when reported. Its original `host` or
`simulated` source is visible and exported. Host readings may be cached for 15 seconds. Mounts
can share backing storage, so the app does not add their capacities together. Mounted filesystem
usage includes allocations outside the chosen folder, reserved space and metadata and is distinct
from the folder's logical file-size total.

Trends contain observations actually collected by this app. At most 24 observations per scope
and eight scopes are retained, with a 160 KiB encoded history budget. Refreshes within 15 seconds
replace an observation. Sources never mix in a series. A chart needs at least two different
measurement times; otherwise the interface says so. The graph shows actual time spacing, its
value range and an accessible table of the same observations.

JSON export uses the destination picker and includes source-tagged snapshots, measurement or
retrieval times, partial-scan state and histories belonging to the currently authorized visible
scopes. Opaque file-handle IDs and unrelated folder histories are omitted. Settings and history
are validated when restored and flushed on suspend/pagehide. All interface text is translated
into ten languages; tables scroll within the window on narrow screens.

## Permissions

- `files:pick`: select a persistent, read-only folder and restore its shared handle.
- `storage:usage.read`: measure the selected folder through the person's authorized file view.
- `system:metrics.read`: read mounted filesystem capacity and usage.
- `files:save`: export a JSON report through the destination picker.
- `storage:app`: persist `settings` and bounded measured `history` per person.

The person's role must also allow the underlying file and system reads. The app never mounts,
unmounts, deletes or changes any file or host service.

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/disk
cd official-apps/disk && pnpm exec everyos-app validate
```
