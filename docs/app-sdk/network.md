# Network access for desktop apps

Desktop apps run in a sandbox whose content security policy only lets them load their own files
(`connect-src 'self'`), and requests to the EveryOS API from an app's opaque origin are refused.
An app reaches the network only through the operations below, which run on the server behind the
`network:outbound` capability and the administrator's **network access policy**. There is no
general proxy: every target is checked against the policy, and nothing is reachable until an
administrator allows it.

## The policy

Administrators manage it in the App Store: under **Catalog sources → Network access for apps** for
all apps, or on an installed app's page for that app. Each rule is one of:

| Kind          | Pattern                             | Reaches                                                            |
| ------------- | ----------------------------------- | ------------------------------------------------------------------ |
| Host name     | `api.example.com`, `*.example.com`  | that host (or its subdomains, at any depth), public addresses only |
| Address range | `192.168.1.0/24`, `192.168.1.20/32` | addresses in the range, including private ones and this server     |

Every rule lists its ports, and may apply to all apps holding `network:outbound` or to one app
(it goes away when that app is uninstalled). Address ranges must be at least as narrow as `/8`
(IPv4) or `/32` (IPv6), so "everything" cannot be allowed by accident. A range that includes this
server is marked so in the list.

How a target is checked, for every request, every redirect hop, every TLS inspection, every
chosen DNS server and every monitor check:

1. A rule must name the target's port.
2. The host name is resolved; **all** of its addresses must pass, and the connection is pinned to
   the checked address (no second lookup an attacker could change).
3. A host-name rule allows public addresses only, so a public name that resolves to a private or
   loopback address is refused (DNS rebinding). Private, loopback and local-network addresses
   need an address-range rule that contains them.
4. Link-local addresses (including cloud metadata at `169.254.169.254`), unspecified, multicast and
   IPv4-mapped IPv6 addresses are always refused, whatever the rules say.

Only administrators (`settings:manage`) change the policy; people who manage apps can read it.
Rule changes are audited (`desktop-apps.network-rule.create` / `.delete`). Refused targets are
audited as `desktop-apps.network.blocked`, at most once per app, target and ten minutes, so an app
cannot flood the audit log. Individual successful requests are not audited.

## Operations

All are reached with `app.host.call(operation, input)` from `@everyos/app-sdk`; types and limits
(`NET_LIMITS`) are exported by the SDK.

### `net.http`

`{ method, url, headers?, body?, followRedirects?, verifyTls?, timeoutMs? }` → status, headers (as
received, repeats kept), body (text when textual and valid in its charset, base64 otherwise),
timing (DNS, connect, TLS, first byte, total), the answering address and the redirects followed.

- Methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS. `http:` and `https:` URLs without
  credentials in them.
- The request is built from scratch: the app's headers plus `Host`, `User-Agent`
  (`EveryOS-App/1 (<app id>)` unless set), `Accept` and `Content-Length`. No EveryOS cookie, CSRF
  token, session or credential is ever sent. Apps cannot set connection and framing headers
  (`Host`, `Connection`, `Content-Length`, `Transfer-Encoding`, `Upgrade`, `Expect`, `TE`,
  `Trailer`, `Proxy-*` …).
- Request body ≤ 192 KiB; response body kept ≤ 2 MiB after decompression (`truncated` beyond);
  64 headers, 32 KiB of headers; 1–60 s timeout (30 s default).
- Redirects are followed only when asked (≤ 5); each hop is checked against the policy, and
  `Authorization` and `Cookie` are dropped when a redirect leaves the origin.
- `verifyTls: false` accepts certificates the server's trusted roots do not verify (a home
  server's self-signed service); the default refuses them.
- Per app and person: 120 network operations per minute; per person: 4 at once.

### `net.tls`

`{ host, port?, servername?, timeoutMs? }` → protocol, cipher, ALPN, whether the chain verifies
(`authorized`, `authorizationError`), whether the leaf matches the name, and the chain (subject,
issuer, SANs, validity, serial, SHA-256 fingerprint, key type and size). Inspection never trusts
the certificate for anything else.

### `net.dns`

`{ name, type, server?, serverPort?, timeoutMs? }` with types A, AAAA, CNAME, MX, NS, TXT, SOA,
CAA, SRV and PTR (PTR takes an IP address too) → records, status (`ok`, `no-data`, `not-found`,
`refused`, `server-failure`, `timeout`), the servers asked and the time taken. Without `server`, the
query goes to the server's own resolvers and connects to no target, so any name may be asked;
choosing a server makes it a network target (port 53 unless chosen) that the policy must allow.

### Monitors: `net.monitors.*`

HTTP Monitor and Uptime keep checks that EveryOS runs on its own schedule, also while the app is
closed: `list`, `history`, `save`, `delete`, `check` (by hand, at most every ten seconds).

- A monitor belongs to one app and one person; nobody else sees it.
- GET or HEAD, every 60 s to 24 h, an expected status range, an optional keyword, a number of
  failed checks in a row before it is down (1–5) and `verifyTls`.
- Saving needs the target allowed by the policy now. If the policy later refuses it, the monitor
  shows `blocked` instead of failing; if the app loses `network:outbound` or is turned off, it is
  `paused`.
- History keeps the newest 5,000 checks per monitor, none older than 30 days.
- When a monitor goes down or comes back, the person gets an `app-monitor-down` /
  `app-monitor-recovered` notification, if the monitor asks for it, the app holds
  `notifications:send` and the person did not mute the app.
- At most 50 monitors per app and person, 500 in all; four checks run at once.

## Errors

| Code                          | Meaning                                                             |
| ----------------------------- | ------------------------------------------------------------------- |
| `FORBIDDEN`                   | the app does not hold `network:outbound`                            |
| `DESKTOP_APP_NETWORK_BLOCKED` | the policy refuses the target; `details: { host, port, reason }`    |
| `DESKTOP_APP_NETWORK_FAILED`  | DNS, connection, TLS, timeout …; `details.reason` is a `NetFailure` |
| `VALIDATION_FAILED`           | the input is out of bounds (a forbidden header, a bad URL …)        |
| `RATE_LIMITED`                | the per-minute or concurrent budget is spent                        |

An app should explain a `DESKTOP_APP_NETWORK_BLOCKED` refusal with the host and port, and tell the
person that an administrator can allow them on the app's page in the App Store.
