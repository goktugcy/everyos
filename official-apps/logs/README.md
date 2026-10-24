# Log Viewer

Log Viewer (`dev.everyos.logs`) reads authorized journald records through `logs.query`.
The API enforces the app's `logs:read` grant and the person's role; the agent uses the existing
bounded journal reader with validated parameters and fixed command arguments. The app never
controls services, modifies journal retention or deletes host records.

Search messages as case-insensitive literal text, optionally selecting an exact systemd unit,
severity threshold and time range. Severity includes the selected level and more severe entries.
Relative windows are recalculated on each read. Custom times use the browser's displayed time
zone and reject invalid dates, reversed bounds and nonexistent local times. Drafts and up to
20 named filters persist per person, validated on restoration. Removing a filter asks for
confirmation and leaves all journal records intact.

The live view polls the typed operation about every three seconds while active, with one request
at a time. Suspend stops polling; resume checks for new records. Pause freezes the view and
fences an outstanding poll. Pages merge by opaque cursor, preserve timestamp order and remove
duplicates. Older entries load from the exclusive oldest cursor. Navigating pages pauses live
updates so new records do not move the page being read. A finite end time disables live updates.

The buffer holds at most 1,000 entries and 4 MiB of encoded entry data. The collector limits
individual messages to 16,384 characters. The table shows 100 rows at a time and short message
previews; selecting a row opens its complete collected message and unit/identifier/PID/host
metadata. The app reports buffer limits, missed live-page intervals and stale snapshots explicitly.
A data-source change starts a new view instead of mixing host and simulated records. Simulated
development data is prominently labelled and keeps `source: "simulated"` in exported JSON.
Revoking permission clears the table and detail dialog; late replies cannot restore them.

The file picker exports every loaded entry, including full collected messages, applied filters,
source, retrieval/generation times and pagination/limit/gap flags. It does not claim to export
history beyond the loaded buffer. No log content is persisted in app storage. All interface text
is localized in ten languages; common messages and severity names reuse the core locale resources.

## Permissions and storage

- `logs:read`: authorized journal records, read-only.
- `files:save`: export the loaded report through the destination picker.
- `storage:app`: `draft`, named `filters` and the `live` refresh preference.

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/logs
cd official-apps/logs && pnpm exec everyos-app validate
```

Logic/interface tests cover filters, cursor merging, byte/count limits, source changes, live
suspend/resume, pagination, export, presets and permission revocation. The browser fixture uses
the explicitly simulated development log source through the real sandbox bridge. The real
journald provider has separate query/follow regression tests ensuring literal searches, command
bounds and unavailable-collector errors. Reading a real journal requires host support and the
agent's OS permissions; unsupported hosts never fall back to invented records.
