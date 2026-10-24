# Network Tools

Network Tools (`dev.everyos.network`) reads interfaces, link state, MAC, MTU, reported link speed,
IPv4/IPv6 addresses with prefixes, default gateways and DNS through `system.network`. Its route
summary lists the default gateways the host reports, rather than claiming a complete routing
table. Missing gateway or DNS data is labelled as not reported. Host internet reachability uses
the existing configured endpoint probe, including its checked time and up to 60-second cache.

Choose an interface for its detail panel; that selection persists across reopenings.

`system.metrics` supplies per-interface receive/transmit rates with a separate source and actual
measurement timestamp. Unavailable measurements stay unavailable; they never become invented
zeros. Both sources retain their original `host` or `simulated` labels. A failed refresh keeps
the last snapshot with an explicit stale-data notice. Permission changes clear protected data.
Optional ten-second refresh runs only while active and with no prior read still pending; suspend
stops the timer and resume refreshes immediately. The preference and endpoint draft persist per
person, including on suspend/pagehide, with shape validation when restored.

The endpoint diagnostic sends a typed `net.http` HEAD request with TLS verification and a
ten-second timeout. Each target and redirect must pass the administrator's App Store network
policy. HTTP/HTTPS URLs cannot contain credentials or fragments. A received HTTP response is
shown independently from its status code: a 404 response demonstrates an answering endpoint,
without claiming the service is healthy. Failures explain blocked targets and permissions in the
active language. Permission revocation fences late results from outstanding checks.

The destination picker exports a versioned JSON report with source-tagged network snapshots,
retrieval and measurement times, interface rates, failure codes and the last attempted endpoint.
Successful checks include URL, status, address, timing and redirect metadata. HTTP bodies,
headers (including cookies), and unrelated CPU, disk or thermal measurements are omitted.
All interface text is translated in ten languages; long addresses wrap and tables scroll inside
the window on phones.

## Permissions and storage

- `system:network.read`: host interfaces, gateways, DNS and configured reachability results.
- `system:metrics.read`: measured interface traffic.
- `network:outbound`: approved endpoint diagnostics only.
- `files:save`: diagnostic reports through the destination picker.
- `storage:app`: `settings` containing the endpoint draft and automatic refresh preference.

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/network
cd official-apps/network && pnpm exec everyos-app validate
```

Reported fields depend on OS support and agent permissions. In particular, non-Linux hosts may
provide real addresses while gateway, DNS, link speed or per-interface rate fields are unavailable.
