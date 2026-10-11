# Configuration

Otuken runs with secure defaults and no configuration file. Settings resolve in this order (first
match wins):

1. environment variables
2. the YAML file
3. built-in defaults

Unknown keys and invalid values are rejected at startup with a precise error. Nothing is silently
ignored.

## API: `/etc/otuken/config.yaml`

```yaml
server:
  # Default bind. Use a Tailscale or LAN address only deliberately.
  host: 127.0.0.1
  port: 7470
  # Reverse proxies whose X-Forwarded-* headers are trusted (IPs or CIDRs), e.g. [127.0.0.1].
  trustedProxies: []
  # Extra origins accepted for state-changing requests, e.g. ["https://otuken.example.ts.net"].
  publicOrigins: []
  # Optional direct TLS. A reverse proxy or `tailscale serve` is recommended instead.
  # tls:
  #   certFile: /etc/otuken/tls/cert.pem
  #   keyFile: /etc/otuken/tls/key.pem
paths:
  dataDir: /var/lib/otuken
  webDir: /usr/lib/otuken/web
  secretKeyFile: /var/lib/otuken/secret.key
  agentSocket: /run/otuken/agent.sock
  agentKeyFile: /etc/otuken/agent.key
security:
  sessionIdleMinutes: 720 # 12 h
  sessionMaxAgeHours: 168 # 7 days
  cookieSecure: auto # auto | always | never
  hsts: false # enable only when Otuken is always reached over HTTPS
logging:
  level: info # trace | debug | info | warn | error | fatal | silent
  format: json # json (journald) | pretty
# File manager locations; nothing is exposed until roots are listed (docs/files.md).
files:
  roots: []
  maxUploadMiB: 16384
  minFreeMiB: 1024
  homes: true # private home folders with standard folders (docs/files.md)
# Backups (docs/backups.md). The directory must belong to the otuken user.
backups:
  dir: /var/lib/otuken/backups/archives # e.g. a separate disk
  minFreeMiB: 1024 # never leave less free space than this
  maxUploadMiB: 65536 # largest archive accepted by "Upload backup"
```

### Environment variables

| Variable                                       | Meaning                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `OTUKEN_ENV`                                   | `production` (default) or `development`                              |
| `OTUKEN_CONFIG`                                | Path to the YAML file. If set, the file must exist.                  |
| `OTUKEN_DEV_ROOT`                              | State directory in development mode (set by `pnpm dev`)              |
| `OTUKEN_HOST`, `OTUKEN_PORT`                   | Bind address and port                                                |
| `OTUKEN_DATA_DIR`                              | Overrides `paths.dataDir`                                            |
| `OTUKEN_WEB_DIR`                               | Overrides `paths.webDir` (directory containing the built web client) |
| `OTUKEN_SECRET_KEY_FILE`                       | Overrides `paths.secretKeyFile`                                      |
| `OTUKEN_AGENT_SOCKET`, `OTUKEN_AGENT_KEY_FILE` | Agent connection                                                     |
| `OTUKEN_LOG_LEVEL`                             | Log level                                                            |
| `OTUKEN_BACKUP_DIR`                            | Overrides `backups.dir`                                              |

## Agent: `/etc/otuken/agent.yaml` (root-owned)

```yaml
socketPath: /run/otuken/agent.sock
agentKeyFile: /etc/otuken/agent.key
socketGroup: otuken # group allowed to connect (name or gid)
logLevel: info
# Extra units Otuken may only start (never stop, restart, reload, enable or disable)
# (exact names or * globs), on top of the built-in list (SSH, Tailscale, Otuken,
# D-Bus, networking, systemd-*, gettys, user managers).
protectedUnits:
  - nginx.service
  - "docker*.service"
# "host:port" endpoints probed with a TCP connect to tell LAN-only from internet
# access. Probed at most once a minute and only when network status is requested.
# Default: ["1.1.1.1:443", "9.9.9.9:443"]. An empty list disables the check.
internetCheckTargets: []
# Containers Otuken may only start, including through Compose (up/update can recreate).
protectedContainers:
  - portainer
  - "traefik*"
# Optional: discovery and Compose actions both use this Unix socket.
dockerSocket: /var/run/docker.sock
# Optional: tailscaled's LocalAPI socket when it is not in a standard place.
tailscaleSocket: /var/run/tailscale/tailscaled.sock
```

The agent honours `OTUKEN_ENV`, `OTUKEN_AGENT_CONFIG`, `OTUKEN_AGENT_SOCKET`,
`OTUKEN_AGENT_KEY_FILE` and `OTUKEN_LOG_LEVEL`. In development only, `OTUKEN_AGENT_SIMULATE=1`
answers service, log and Docker operations from in-memory simulators even when host tools exist (the e2e
suite uses it). The agent refuses to start with this variable in production. Also in development
only, `OTUKEN_TAILSCALE_SOCKET` points the agent at another tailscaled socket (the e2e suite runs
a stand-in LocalAPI there).

Development discovers real Docker through the configured Unix socket when present but refuses
every real Docker mutation. Without a socket it uses clearly labeled simulated data. Production
never substitutes simulated Docker. The API needs no Docker socket access.

## Remote access recipes

- **Tailscale (recommended):** keep `host: 127.0.0.1` and run
  `tailscale serve --bg --https=443 http://127.0.0.1:7470`. Then set
  `trustedProxies: [127.0.0.1]` and `publicOrigins: ["https://<machine>.<tailnet>.ts.net"]`.
  _Not yet verified on the target Raspberry Pi._ Which `X-Forwarded-*` headers `tailscale serve`
  sends decides whether Otuken detects HTTPS automatically. This recipe will be confirmed (and
  `cookieSecure: always` recommended if needed) during Phase 3 hardware testing.
- **Reverse proxy (Caddy/nginx) on the same host:** proxy to `127.0.0.1:7470`, forward
  `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`, then set
  `trustedProxies: [127.0.0.1]` and `hsts: true` if the site is HTTPS-only.
- **Plain LAN HTTP:** `host: 0.0.0.0`. Passwords and session cookies cross the network
  unencrypted, and Otuken logs a warning and shows one in the UI. Use this only on networks you
  fully trust.
