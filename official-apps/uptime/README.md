# Uptime

Uptime (`dev.everyos.uptime`) combines real host uptime, read-only service state and approved HTTP
endpoint checks. Host values come from `system.info`, including measured uptime, boot time and
collection time. Service values come from `system.services`, with their independent source and
retrieval time. Both retain their `host` or explicitly labelled `simulated` source.

The summary describes observed checks rather than claiming every part of the server is healthy.
A passing summary requires real, fresh host/service data and at least one enabled, checked
endpoint. Missing permissions, failed reads, simulated sources, pending/paused checks, host data
older than 60 seconds and overdue checks make coverage incomplete. A blocked target needs
attention; an actual failed endpoint or real failed service is shown as an observed failure.
Failed refreshes retain the previous measured values and change the summary to insufficient data.
Inactive services are not automatically treated as failures.

Endpoints belong to this app and person; HTTP Monitor's checks are separate. Create or edit a
name, HTTP/HTTPS URL, interval, timeout, expected status range, consecutive-failure threshold,
notification preference and enabled state. Checks use GET and always verify TLS. Credentials in
URL authority and URL fragments are rejected. Every target and redirect must pass the host's
App Store network policy. The existing server scheduler keeps checking saved endpoints when the
window is closed, applies the ten-second manual-check limit and handles failure/recovery
notifications subject to capabilities and the person's notification settings. Deletion asks for
confirmation and removes that endpoint and its history.

Availability statistics are the server's measured 24-hour and seven-day check success rates, not
an inferred proportion of elapsed time. History reads up to 5,000 checks in the selected 24-hour
or seven-day period, within the server's 30-day retention. Its table has 100-row pages and the
timeline shows the newest 60 actual checks. The incident list shows at most 100 observed
transitions into failure, policy block or the first successful check after either. An initial
failure is marked as a partial start because earlier checks may be outside the loaded history.
These observations do not invent historical service incidents or bypass the configured failure
threshold that determines each monitor's state.

The window and health widget refresh every 15 seconds while active. Automatic polling waits for
outstanding reads, suspends when hidden and refreshes on resume. Revocation hides protected data
and fences late results. An incomplete endpoint draft persists per person and flushes on
suspend/pagehide; it is validated when restored and asks before discard. All interface text is
translated into ten languages. Tables and long URLs stay inside narrow windows.

The desktop/sidebar widget reads the host, services and this app's endpoint statuses with its own
declared capability subset. It shows measured uptime, observed health and incomplete/simulated
coverage, and opens the full window. It does not mutate endpoint settings or request a file picker.

## Permissions

- `system:metrics.read`: host uptime and system information.
- `system:services.read`: service status, with no start/stop operations.
- `network:outbound`: approved endpoint settings, checks and availability history.
- `notifications:send`: scheduler notifications for failure and recovery.
- `storage:app`: the unfinished endpoint `draft`.
- `widgets:register`: the health widget, declaring `system:metrics.read`, `system:services.read`
  and `network:outbound`; its implementation calls only the three read operations above.

The person's role must also permit the corresponding system and network reads. The app never
restarts the host or changes a host service.

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/uptime
cd official-apps/uptime && pnpm exec everyos-app validate
```
