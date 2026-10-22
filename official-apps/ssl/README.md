# SSL Inspector

EveryOS's TLS inspector (`dev.everyos.ssl`) connects only through the scoped `net.tls` operation.
Enter a host/IP, port and optional DNS server name (SNI). Internationalized names are normalized
without accepting URLs, paths, embedded ports or credentials. The server independently validates
the request and checks the administrator's network policy before connecting.

The report shows the connected address, TLS protocol, cipher suite, ALPN, response time, chain
verification and name matching independently. Each certificate shows subject, issuer, SANs,
validity dates, serial number, SHA-256 fingerprint and public key type/size where available.
Self-signed certificates are identified; expired, future and soon-expiring (within 30 days)
certificates have explicit warnings. Inspecting never changes certificate trust or accepts the
certificate for another operation. Missing optional TLS information is labelled unavailable.

Save up to 50 distinct endpoints, including port and SNI, and select one to inspect it again.
Removing a saved endpoint asks for confirmation. Drafts and endpoints persist on edit, suspend
and pagehide, with validation when read. Errors explain network-policy refusals and recovery in
all ten EveryOS languages, and permission changes are heard immediately. Layouts stack at narrow
widths and all workflows work with the keyboard.

## Permissions and storage

- `network:outbound`: inspect approved TLS endpoints.
- `storage:app`: `draft` and `endpoints`; no credentials or certificate private keys are stored.

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/ssl
cd official-apps/ssl && pnpm exec everyos-app validate
```
