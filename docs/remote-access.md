# Remote access providers

Settings → Remote Access manages Tailscale and NetBird independently. Both may remain installed
and connected. Selecting a provider only selects its settings panel; connecting or disconnecting
one never disables the other. Existing Tailscale diagnostics, menu-bar status, widgets, HTTPS
Serve integration and `/api/system/tailscale/*` routes remain available.

## Connection and configuration

An administrator can install a missing CLI, save DNS/route preferences, connect, disconnect and
inspect peers. All host actions and private peer reads require `system:manage` plus a linked Linux
account with an unlocked sudo grant. `system:read` exposes bounded local node telemetry and peer
counts, but not peer names, addresses or credentials.

NetBird supports Cloud (`https://api.netbird.io`) and a self-hosted HTTPS management origin,
including an explicit port. Paths, credentials, query strings and insecure HTTP origins are
rejected by the API and agent schemas. A self-hosted server needs a certificate trusted by the
host; EveryOS does not disable certificate verification or deploy a management server.

Initial headless enrollment uses a Tailscale auth key or a NetBird setup key from the provider's
management console. A registered device can reconnect with the field empty. An expired or
unenrolled device needs a valid key; interactive SSO and approval in a provider's console remain
provider workflows. Keys are transient: EveryOS passes them through the authenticated agent socket
and the CLI's stdin (`--auth-key=file:/dev/stdin` or `--setup-key-file /dev/stdin`), never argv,
environment, EveryOS settings, audit details or logs. CLI output from mutations is discarded;
errors are static reason codes. Provider-owned identity/configuration files remain provider-owned.

Public desired configuration is stored in existing `instance_settings` entries
`remote-access.tailscale` and `remote-access.netbird`. Saving it does not change a running tunnel;
Connect applies it explicitly, including when already connected. Initial preferences adopt the
current readable settings, falling back to DNS/routes disabled when unavailable. Tailscale uses
`set` for those two preferences before reconnecting an enrolled node, preserving SSH, Serve,
advertisements and existing exit-node preferences. NetBird changes only the specified client DNS,
route and management options. EveryOS does not select exit nodes or advertise new subnet routes.

## Architecture and endpoints

- `packages/shared/src/remote-access.ts` defines provider-neutral node, peer, settings, job and
  conflict DTOs; the strict runtime schemas live in the server-only schemas entry point.
- `RemoteAccessProvider` in `apps/api/src/modules/remote-access/providers.ts` owns configuration,
  audit and typed agent dispatch. The API stays unprivileged.
- `RemoteAccessDriver` in `packages/system/src/remote-access/providers.ts` adapts each vendor's
  CLI/LocalAPI. Drivers receive explicit execution dependencies. No downloaded code is imported.
- `apps/agent/src/remote-access.ts` serializes transitions and owns installation jobs. Agent
  protocol contracts enforce permissions, validation, timeouts and development-mode policy.

| HTTP method | Path                                      | Permission      |
| ----------- | ----------------------------------------- | --------------- |
| GET         | `/api/remote-access`                      | `system:read`   |
| GET         | `/api/remote-access/:provider/peers`      | `system:manage` |
| PUT         | `/api/remote-access/:provider/settings`   | `system:manage` |
| POST        | `/api/remote-access/:provider/install`    | `system:manage` |
| POST        | `/api/remote-access/:provider/connect`    | `system:manage` |
| POST        | `/api/remote-access/:provider/disconnect` | `system:manage` |

Mutations require `confirm: true`. Installation takes `configureRepository`; connection takes
`acknowledgeConflicts` and an optional `credential`. Unknown providers and extra fields are
rejected. Agent operations are `remoteAccess.snapshot`, `.peers`, `.install`, `.connect` and
`.disconnect`; there is no generic shell operation. Configuration and accepted host actions are
audited with the actor and provider, including failures; installation completion is logged by the
agent with a static outcome. The snapshot includes the current agent-owned installation job.

Adding a provider requires an explicit ID/schema entry, driver, fixed installation recipe and
translated presentation. Business logic and the settings screen use the common contracts.

## Installation and lifetime

Automatic installation supports Debian and Ubuntu with APT. EveryOS installs only the fixed
`tailscale` or `netbird` CLI package. A confirmation explains the repository and permits adding it
if absent. Existing administrator-managed vendor repository files are preserved. New repositories
use a dedicated `Signed-By` keyring and deb822 source file, without executing vendor installer
scripts. HTTPS key downloads are bounded, refuse redirects and must match reviewed SHA-256 pins:

- NetBird `https://pkgs.netbird.io/debian/public.key`:
  `6bd434c07e7c3a71211de79ca287e93b45deadedc4b74f1a2e83e11abe6e0bf5`.
- Tailscale `https://pkgs.tailscale.com/stable/{debian|ubuntu}/{codename}.noarmor.gpg`:
  `3e03dacf222698c60b8e2f990b809ca1b3e104de127767864284e6c228f1fb39`.

These are public signing keys. Vendor key rotation deliberately stops automatic setup until a
maintainer reviews the new key. Existing keys/sources are not overwritten. Package operations
reuse the live module/boot mount safety checks, dpkg audit, `--no-remove`, configuration preservation
and the installed EveryOS version pin used for Borg installation. No automatic global dpkg repair,
service removal or unrelated package upgrade is introduced.

Installation returns HTTP 202 and continues in the privileged agent independently of browser or
API request lifetime. Closing a tab or restarting only the API does not cancel APT. Jobs are
in-memory; do not restart the agent or host during package installation. After an agent restart,
the actual installed/daemon state is read again, and unsafe incomplete dpkg state blocks later
package work. No unattended repair or automatic retry is performed.

## Conflict monitoring and limits

The settings screen polls both nodes. Before connecting, the agent reads both again and requires
acknowledgment when another provider is connected. Concurrent provider transitions cannot bypass
this check. Warnings never automatically rewrite DNS, route priorities, firewalls or another VPN.

- Both connected: informational multiple-provider notice.
- Both observed managing DNS: potential DNS/search-domain conflict.
- Overlapping effective IPv4/IPv6 networks: subnet warning with bounded route prefixes.
- Both using default or split-default routes: critical exit-node/default-route warning.
- Both accepting routes: potential future route-policy conflict even without current overlap.
- Missing DNS or route visibility: explicit uncertainty, not a claim that the configuration is safe.

Routes are read from IPv4 and IPv6 kernel tables and correlated to actual local VPN interface
addresses, rather than hardcoded interface names. Routing policy, route priorities, firewall rules,
DNS split-horizon rules and transient changes can still affect traffic; this is a warning system,
not a complete network reachability proof. NetBird's CLI `networks` list may describe advertisements,
so it is not presented as effective accepted routes. Empty NetBird DNS groups do not prove its local
DNS resolver is disabled. Acceptance preferences that the vendor status does not expose remain
unknown. NetBird versions missing the secure enrollment/configuration flags are refused.

Development simulation is explicit (`source: "simulated"` and a visible label) and cannot mutate a
host VPN. Tests cover real adapters with recorded upstream-shaped JSON/LocalAPI fixtures, typed
agent dispatch, privilege boundaries, repository writes in temporary directories, connection races,
job lifetime and the browser workflow. No physical Linux VPN enrollment is claimed by those tests.

Vendor references: [NetBird CLI](https://docs.netbird.io/get-started/cli),
[NetBird Linux installation](https://docs.netbird.io/get-started/install/linux),
[NetBird status source](https://github.com/netbirdio/netbird/blob/main/client/status/status.go),
[Tailscale up](https://tailscale.com/docs/reference/tailscale-cli/up),
[Tailscale secure auth keys](https://tailscale.com/docs/features/access-control/auth-keys/how-to/secure-auth-keys).
