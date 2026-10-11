# Linux power readings and folder icons

The right-hand menu bar shows the managed Linux host's first battery percentage and a plug
icon when external power is connected. Its popover lists each battery and power supply, including
charging state, remaining/full energy, voltage, current, measured watts and reported input limits.
The module can be hidden in Settings → Desktop → Menu bar. Multiple batteries remain separate
instead of displaying an invented combined percentage.

The agent's read-only `power.status` operation reads `/sys/class/power_supply` with no shell or
power-setting commands. Kernel micro-units are converted to W, V, A and Wh. Battery power uses
`power_now`, falling back to the magnitude of `voltage_now × current_now`. A supply's input limit
uses `input_power_limit`, or `voltage_max × current_max`; this is a limit, not measured consumption.
Device-scoped peripheral batteries and absent batteries are excluded. Missing values remain
`null`, and an empty/unavailable sensor set is explicitly shown in the UI. Non-Linux development
hosts return unavailable. No browser battery API or macOS collector is used.

`GET /api/system/power` requires `system:read`, rejects query parameters and returns a validated
`PowerStatus` with `source: "host"` and a timestamp. Agent caching is 10 seconds; visible browser
tabs refresh every 15 seconds. Read failures retain the previous reading and display an error;
the timestamp identifies the retained measurement.

Settings → Appearance → Folder icons offers Classic, Soft, Outline, Amber, Green and Violet
presets plus owned PNG/WebP/JPEG uploads. The default applies to desktop folders and both Files
views. A single folder's context menu opens the same picker with an option to return to the
default. On the desktop, folder selection highlights only the glyph, leaving its label background
transparent. Keyboard focus and selection state remain exposed.

Appearance preferences accept optional `folderIcon` and `folderIcons` fields. Each override has
`{ root, path, icon }`; paths are nonempty, normalized relative paths, with at most 500 unique
locations. An icon is `{ kind: "preset", id }` or `{ kind: "uploaded", iconId }`. Omitting these
fields preserves older preferences. Successful rename/move operations through the web client
carry folder and descendant overrides to the destination; copies retain the original and copy
overrides while space remains. External host renames are not tracked. Overrides retained during
trash allow an original-path restore to keep its appearance.

The `/api/folder-icons` endpoints require `preferences:manage` for the authenticated owner:

- `GET /`: `{ icons: WallpaperInfo[] }`.
- `POST /`: raw PNG/WebP/JPEG upload, returning image metadata with `201`.
- `GET /:id/image`: owned raster bytes with verified MIME, `nosniff` and private immutable caching.
- `DELETE /:id`: removes an unused owned upload with `204`; referenced icons return `409`.

Uploads are bounded to 2 MiB, 1024 pixels per edge and 20 icons per user, independently of wallpaper
quota. Image headers are inspected, streams are capped even without Content-Length, and SVG/HTML
are rejected. Preference writes reject uploaded icon ids not owned by the current user. Uploads
and deletions are audited without raw images or user paths.

Folder images share the existing private wallpaper asset store, with `folder-icon-` filenames
separating purposes. Existing wallpaper endpoints cannot list, serve or delete folder icons.
Account deletion and wallpaper archive backup/restore cover both kinds; appearance preferences
preserve references. No additional database migration or independent restore lifecycle is needed.
