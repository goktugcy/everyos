# HTTP Monitor

EveryOS's HTTP Monitor (`dev.everyos.httpmonitor`) uses the typed `net.monitors.*` host
operations. Saved monitors belong to the current person and app; EveryOS checks them on its own
schedule while the window is closed. The API independently validates every change and requires an
administrator-approved network target and port on each request and redirect.

Create up to 50 monitors with GET or HEAD, a 60–86,400 second interval, 1–30 second timeout,
inclusive expected status range, optional exact body text for GET, 1–5 consecutive failures before
marking down, TLS verification and failure/recovery notifications. The interface distinguishes
pending, up, down, blocked and paused states. It shows the last check, state transition, response
code, latency, 24-hour/7-day successful-check shares and average latency. These shares count
checks, rather than claiming a measured duration of uninterrupted availability.

Select a 24-hour, 7-day or 30-day history. EveryOS retains at most 5,000 checks for 30 days; the
timeline presents the latest 60 chronologically and the table pages through 100 rows at a time.
CSV export includes every returned check with UTC timestamps, machine-readable failure reasons,
RFC 4180 quoting and neutralized spreadsheet formulas in text cells. The person chooses the
destination through EveryOS's file picker.

The window refreshes every 30 seconds while active, stops polling on suspend and reloads on
resume. Manual checks respect the server's ten-second cooldown. Network errors explain blocked
targets and App Store policy recovery in all ten languages. Revoking network permission clears
the displayed health state; notification permission and muted notifications are described
separately. Deleting a monitor and its history or discarding a draft asks for confirmation.
Incomplete form input persists on edits, suspend and pagehide, and is validated when restored.

## Permissions and storage

- `network:outbound`: read, configure and check this app's monitors.
- `notifications:send`: EveryOS sends down/recovery notifications unless the person muted the app.
- `files:save`: export history through the destination picker.
- `storage:app`: the `draft` configuration; no credentials are accepted in URLs.

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/httpmonitor
cd official-apps/httpmonitor && pnpm exec everyos-app validate
```

The browser acceptance test runs a real loopback HTTP endpoint, first verifies policy refusal,
then checks it through the sandbox bridge and waits for the real background schedule with the
window closed. It reopens the saved monitor on desktop and mobile to verify the failure history.
