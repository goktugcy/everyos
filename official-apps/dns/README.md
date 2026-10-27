# DNS Lookup

EveryOS's DNS tool (`dev.everyos.dns`) queries A, AAAA, CNAME, MX, NS, TXT, SOA, CAA, SRV and PTR
records through `net.dns`. Common types runs six queries serially to respect the shared network
budget. Names are validated and internationalized labels converted to ASCII without reordering
service labels; PTR also accepts IP addresses.

Results include a record count chart, record values, TTLs where returned, resolver addresses,
response timing and a distinct status for empty, missing, refused and failed queries. TXT records
identify SPF, DMARC, DKIM and verification values. Copy individual values or all answers as zone
file lines. History keeps the latest 50 distinct queries, including custom resolver ports, across
reloads. Select a history entry to query it again; clearing history asks for confirmation.

The default uses the host's resolvers. Cloudflare, Google, Quad9 and custom IP resolvers must be
allowed by an administrator's network policy. A refusal explains the target and App Store action;
permission changes take effect in the open app. No direct browser network requests are made.

## Permissions and storage

- `network:outbound`: validated DNS operations, including policy checks for custom resolvers.
- `storage:app`: validated `settings` and `history`, saved as edited and on suspend/pagehide.
- `clipboard:write`: copying answers selected by the person.

All ten EveryOS languages are bundled. The layout stacks the history below results on narrow
windows. Forms, results and history are keyboard accessible; statuses also have text labels.

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/dns
cd official-apps/dns && pnpm exec everyos-app validate
```
