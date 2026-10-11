# Tailscale integration (Phase 7)

Tailscale is optional. Otuken works fully without it; when it is not installed or its LocalAPI is
not reachable, the Tailscale app shows why ("not detected", "permission denied") and the menu bar
hides its Tailscale link. Otuken **never changes the Tailscale configuration**: it reads
tailscaled's LocalAPI and explains what it finds.

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
show "not readable". Only the fields Otuken displays are kept; keys and user records never leave the
agent. Responses are capped at 4 MiB.

## What Otuken shows

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

## Remote access to Otuken

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

When Tailscale runs but Otuken is not published, the app suggests exactly this command for the
node's MagicDNS name. It does not run it.

## Warnings

| Warning             | Severity | Meaning                                                                             |
| ------------------- | -------- | ----------------------------------------------------------------------------------- |
| `needs-login`       | warning  | tailscaled waits for sign-in or device approval                                     |
| `not-running`       | warning  | Tailscale is stopped or starting                                                    |
| `key-expiring`      | warning  | The node key expires within 14 days; remote access stops when it does               |
| `key-expired`       | critical | The node key has expired                                                            |
| `exit-node-offline` | warning  | The exit node in use is offline                                                     |
| `funnel-public`     | critical | Otuken is reachable from the public internet through Funnel                         |
| `origin-missing`    | warning  | A Serve URL for Otuken is not in `server.publicOrigins` (changes would be rejected) |
| `proxy-untrusted`   | warning  | Otuken is behind Serve but `127.0.0.1` is not a trusted proxy                       |
| `health`            | info     | tailscaled's own health messages                                                    |

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

- Read-only by design: connecting, logging in, choosing an exit node, or changing Serve and Funnel
  stay in the Tailscale CLI or admin console.
- Which forwarding headers `tailscale serve` sends (and so whether HTTPS is detected without
  `cookieSecure: always`) is verified with production packaging in Phase 8.
