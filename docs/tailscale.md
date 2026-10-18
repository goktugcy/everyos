# Tailscale integration

Tailscale is optional. EveryOS works fully without it; when it is not installed or its LocalAPI is
not reachable, the Tailscale app shows why ("not detected", "permission denied") and the menu bar
hides its Tailscale link. EveryOS reads tailscaled's LocalAPI and explains what it finds. The only
change it ever makes is **its own HTTPS Serve handler**, when an administrator turns it on.

## Data sources

The agent talks to tailscaled's LocalAPI over its Unix socket (`/var/run/tailscale/tailscaled.sock`
or `/run/tailscale/tailscaled.sock`; `tailscaleSocket` in `agent.yaml` overrides it). It uses only
`GET` requests:

| Endpoint                    | Used for                                                                  |
| --------------------------- | ------------------------------------------------------------------------- |
| `/localapi/v0/status`       | Connection state, node name, addresses, tailnet, exit node, health, peers |
| `/localapi/v0/prefs`        | Tailscale SSH, Shields Up, accepted routes and DNS, advertised routes     |
| `/localapi/v0/serve-config` | Serve and Funnel handlers                                                 |

Preferences and the Serve configuration are optional: older versions or restricted access simply
show "not readable". Only the fields EveryOS displays are kept; keys and user records never leave the
agent. Responses are capped at 4 MiB.

## What EveryOS shows

- **Connection** (everyone with `system:read`, also in the menu bar and the Tailscale widget):
  state, node name, MagicDNS name, tailnet, addresses, exit node, peer counts, version and health
  messages.
- **This device:** OS, home DERP region, node key expiry, whether it serves subnets or is usable
  as an exit node, tags, MagicDNS, and the preferences listed above.
- **Serve and Funnel:** every handler with its target, flagging Funnel (public internet) ones.
- **Devices** (`system:manage`, administrators only): the tailnet's other devices with OS,
  address, online state or last seen, the current connection path (direct, relayed through a DERP
  region, or idle), traffic and exit-node role. A device list reveals personal hostnames, so
  viewers and operators only see counts.

## Remote access to EveryOS

The API recognizes Serve handlers (web proxies and TCP forwards) that point at its own port on a
local address and checks them against its configuration. The recommended setup is:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:7470
```

```yaml
server:
  host: 127.0.0.1
  trustedProxies: [127.0.0.1]
  publicOrigins: ["https://<machine>.<tailnet>.ts.net"]
```

An administrator can do all of it with one button instead (Settings › Security › HTTPS, or the
suggestion in the Tailscale app). The agent operation `tailscale.serve` (`system:manage`, a
sudo-unlocked linked Linux account, refused by a development agent) reads the Serve configuration
with its ETag and adds only `https://<node>.<tailnet>.ts.net/` → `http://127.0.0.1:<port>`; it
refuses when port 443 serves something else or is published with Funnel, when the tailnet has
HTTPS certificates off (MagicDNS and HTTPS Certificates in the admin console) or when Tailscale
is not connected, and it never turns Funnel on. EveryOS then allows that origin and trusts the
loopback proxy's forwarded headers without editing `config.yaml`. Turning it off removes only its
own handler (other handlers on the same name stay). Changes are audited as `https.tailscale`.

## Warnings

| Warning             | Severity | Meaning                                                                              |
| ------------------- | -------- | ------------------------------------------------------------------------------------ |
| `needs-login`       | warning  | tailscaled waits for sign-in or device approval                                      |
| `not-running`       | warning  | Tailscale is stopped or starting                                                     |
| `key-expiring`      | warning  | The node key expires within 14 days; remote access stops when it does                |
| `key-expired`       | critical | The node key has expired                                                             |
| `exit-node-offline` | warning  | The exit node in use is offline                                                      |
| `funnel-public`     | critical | EveryOS is reachable from the public internet through Funnel                         |
| `origin-missing`    | warning  | A Serve URL for EveryOS is not in `server.publicOrigins` (changes would be rejected) |
| `proxy-untrusted`   | warning  | EveryOS is behind Serve but `127.0.0.1` is not a trusted proxy                       |
| `health`            | info     | tailscaled's own health messages                                                     |

The host monitor turns two of them into notification conditions, raised and resolved
automatically: `tailscale-key-expiry` (everyone with `system:read`) and `tailscale-funnel`
(administrators, category security). `tailscale-offline` (Phase 3) still reports a disconnected
node.

## API

| Method | Path                             | Permission      | Notes                                             |
| ------ | -------------------------------- | --------------- | ------------------------------------------------- |
| `GET`  | `/api/system/tailscale`          | `system:read`   | Connection status (Phase 3)                       |
| `GET`  | `/api/system/tailscale/overview` | `system:read`   | Status, details, remote-access analysis, warnings |
| `GET`  | `/api/system/tailscale/peers`    | `system:manage` | The tailnet's other devices                       |

Agent operations: `tailscale.status`, `tailscale.details` (`system:read`, also for the host
monitor) and `tailscale.peers` (`system:manage`, users only).

## Limitations

- Connecting, logging in, choosing an exit node, Funnel and any Serve handler other than
  EveryOS's own stay in the Tailscale CLI or admin console.
- Detecting HTTPS behind Serve relies on the `X-Forwarded-Proto` header Serve sends; the origin is
  allowed either way.
