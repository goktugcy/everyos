# Port Inspector

Port Inspector (`dev.everyos.ports`) reads the current host's listening TCP/UDP sockets through
the approved `system.sockets` host operation. The API authorizes the app and person's role, and
the agent's bounded `network.sockets` operation reads Linux `/proc/net` and process descriptors.
The app never connects to listed addresses, scans targets, opens a port or controls a process.

The table shows protocol, bind address, port, bind scope and the process name when the agent can
read it. A missing process is labelled unavailable rather than guessed from the port number.
Bind scope distinguishes all interfaces, loopback and a specific address; it does not claim that
a listener is reachable through a firewall. Connection counters show established, time-wait and
other TCP connections separately from listening sockets.

Search protocol, address, port and process with whitespace-separated terms. Filter by protocol,
address family and bind scope. Validated filters persist per person and the table pages through
100 rows at a time in ascending port order. Manual refresh uses the existing agent cache (up to
30 seconds). Retrieval time is labelled explicitly, and a failed refresh keeps the last result
with a stale-data notice. Permission revocation clears it from the interface. Simulated data, if
provided by a development host, is prominently labelled and carries `source: "simulated"` in CSV.
An unsupported host shows an error; it never falls back to invented listeners.

CSV exports all matching results, rather than just the visible page, with source, retrieval time
in UTC, protocol, address, port, process and bind scope. Text cells use RFC 4180 quoting and
spreadsheet-formula neutralization. The person chooses the destination through the file picker.
All interface text is localized in ten languages and narrow layouts keep the table scrollable.

## Permissions and storage

- `system:sockets.read`: list authorized host sockets and connection counters (read-only).
- `files:save`: export the filtered snapshot through the destination picker.
- `storage:app`: the `filters` key; no host socket state is persisted in app storage.

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/ports
cd official-apps/ports && pnpm exec everyos-app validate
```

The host collector requires Linux. Process names depend on the agent's OS permissions. Other
operating systems show that socket collection is unavailable rather than an empty success state.
The browser workflow exercises actual loopback listeners and CSV export on Linux CI, and the
unavailable state on other operating systems. Both paths reopen saved filters on desktop/mobile.
