# HTTP API

Base path: `/api`. Bodies are JSON except raw wallpaper, folder-icon, file and backup uploads. JSON responses are never cached
(`Cache-Control: no-store`); owned raster images use private immutable caching.

## AI assistants

All `/ai-agents` routes require `apps:manage` and `terminal:access`. Settings and conversations
are scoped to the authenticated account; there is no caller-supplied user ID, Compose template,
agent command, arbitrary upstream path or secret-read endpoint. Params/query/body use strict schemas.

| Method     | Path                                 | Behavior                                                                                                           |
| ---------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| GET        | `/ai-agents`                         | Every assistant's (`local`, `hermes`, `openclaw`) sanitized settings, live API state and owned app job             |
| GET        | `/ai-agents/:kind`                   | One assistant's state                                                                                              |
| PUT        | `/ai-agents/:kind`                   | Save settings; blank keys preserve existing matching credentials; apply an installed managed configuration         |
| POST       | `/ai-agents/:kind/actions`           | Confirmed fixed `install`, `start`, `stop`, `restart`, `retry`; returns an app job                                 |
| GET / POST | `/ai-agents/:kind/conversations`     | List metadata / create an empty private conversation                                                               |
| GET        | `/ai-agents/:kind/conversations/:id` | Owner's decrypted history                                                                                          |
| PATCH      | `/ai-agents/:kind/conversations/:id` | `{favorite?, archived?}`: favorites and archive are exclusive; returns the conversation summary                    |
| DELETE     | `/ai-agents/:kind/conversations/:id` | Confirm ID and delete local history                                                                                |
| GET        | `/ai-agents/:kind/models`            | Models the chat can use, grouped by provider, with the current one and how switching works; `?refresh=1` refetches |
| PUT        | `/ai-agents/:kind/model`             | `{model: {provider, model} \| null, restart?}`: only a listed model; managed OpenClaw needs `restart: true`        |
| POST       | `/ai-agents/:kind/chat`              | CSRF-protected `{conversationId, content}`; SSE `ready`, `delta`, `complete` or sanitized `error`; never replayed  |
| POST       | `/ai-agents/:kind/chat/cancel`       | Abort the owner's active conversation and wait for the upstream turn to release its busy state                     |
| POST       | `/ai-agents/local/preview`           | `{behavior, prompt}`: try unsaved local behavior on the saved model; SSE `delta`, `complete`; nothing stored       |

The chat stream uses existing heartbeat access checks and bounded DNS-pinned upstream transport.
`GET /ai-agents/discover` returns sanitized native/account and Docker discoveries, with no keys or
chat contents. `POST /ai-agents/:kind/import` validates the native candidate ID, settings fingerprint,
settings/history choices and explicit kind confirmation, then returns import/skip counts.
Agent credentials and messages are excluded from audit metadata. See [AI assistants](ai-agents.md).

Local model servers and the system-wide EveryOS Ollama (servers are named by discovered id, never by URL):

| Method | Path                                         | Behavior                                                                                   |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| GET    | `/ai-agents/local-models`                    | EveryOS Ollama state and GPU hardware, discovered servers with models, downloads           |
| POST   | `/ai-agents/local-models/ollama`             | `{acceleration, confirm: "ollama"}`: install or reconfigure; GPU needs an administrator    |
| POST   | `/ai-agents/local-models/ollama/actions`     | Confirmed `start`, `stop`, `restart`, `retry`; returns an app job                          |
| POST   | `/ai-agents/local-models/servers/:id/pull`   | `{model, confirmExternal?}`: start a download on an Ollama server; external ones confirmed |
| POST   | `/ai-agents/local-models/pulls/:id/cancel`   | Cancel a running download                                                                  |
| DELETE | `/ai-agents/local-models/servers/:id/models` | `{model, confirm: model, confirmExternal?}`: delete a model                                |

**Errors** always have this shape:

```json
{
  "error": {
    "code": "AUTH_INVALID_CREDENTIALS",
    "message": "Invalid username or password",
    "details": {}
  }
}
```

`code` is stable. The full list is in `packages/shared/src/errors.ts`. `message` is English and meant
for logs; clients show the localized text for `code`. A `429` response carries `Retry-After` and
`details.retryAfterSeconds`.

**State-changing requests** (`POST`, `PATCH`, `PUT`, `DELETE`) must satisfy the CSRF rules in
[security-model.md](security-model.md#csrf-and-browser-hardening-p1). Authenticated requests send the
`X-EveryOS-CSRF` header with the `csrfToken` from the session.

## Public

| Method & path           | Description                                                                                                                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`           | Readiness. Returns `200` with `{ status: "ok" \| "degraded", checks: { database, agent } }`, or `503` if the database is unreachable. Reveals no version or host details.                                                                                                                           |
| `GET /bootstrap`        | `{ product, version, setupRequired, defaultLocale, transport: { secure, loopback }, mode }`.                                                                                                                                                                                                        |
| `POST /setup`           | Only while no user exists. Body: `{ setupToken, username, displayName, password, locale }`. Returns `201` with `SessionInfo` and sets the session cookie. Errors: `SETUP_TOKEN_INVALID` (403), `SETUP_ALREADY_COMPLETED` (409), `AUTH_PASSWORD_POLICY` (400, `details.violations`), `RATE_LIMITED`. |
| `POST /auth/login`      | Body: `{ username, password }`. Returns `{ status: "authenticated", session }`, or `{ status: "totp_required", challengeId, expiresAt }`. Errors: `AUTH_INVALID_CREDENTIALS` (401), `AUTH_ACCOUNT_DISABLED` (403), `RATE_LIMITED` (429).                                                            |
| `POST /auth/login/totp` | Body: `{ challengeId, code }` or `{ challengeId, recoveryCode }`. Same success shape. Errors: `AUTH_TOTP_INVALID`, `AUTH_CHALLENGE_EXPIRED` (also returned when the challenge is used from a different IP).                                                                                         |

## Session (authenticated)

| Method & path               | Description                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /auth/session`         | `SessionInfo`: `{ user, permissions, csrfToken, session: { id, createdAt, expiresAt, locked }, twoFactorSetupRequired }`. |
| `POST /auth/logout`         | Revokes the current session and clears the cookie. Returns `204`.                                                         |
| `GET /auth/sessions`        | `{ sessions: SessionSummary[] }` for the current user.                                                                    |
| `DELETE /auth/sessions/:id` | Revokes one of your own sessions. Returns `204`.                                                                          |
| `POST /auth/lock`           | Locks only the current session on the server. Returns `204` and records an audit event.                                   |
| `POST /auth/unlock`         | `{ password }` → `SessionInfo`. Re-authentication is rate-limited and audited.                                            |

Locked sessions receive `423 SESSION_LOCKED` for host/account reads and all mutations except
unlock and logout. Public health/bootstrap, session probing, preference reads and owned wallpaper
images remain readable so the lock screen can render across reloads. UI auto-lock is an inactivity
convenience; server idle/absolute session expiry remains the authentication boundary.

When the two-factor policy covers an account that has no second factor (`twoFactorSetupRequired`),
every request except health, bootstrap, session reads, preference reads, wallpaper images, lock,
unlock, logout and `POST /account/totp/{enroll,enable}` answers `403 TWO_FACTOR_REQUIRED`.

## Personal desktop preferences (`preferences:manage`)

All roles can customize their own desktop. This permission gives no authority over host or
instance settings, or another user's data. Ownership is always taken from the session.

| Method & path              | Description                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /preferences`         | `{ preferences: Partial<PreferenceDocuments> }`. Missing documents use client defaults. Unexpected query fields are rejected.                                                        |
| `PUT /preferences/:key`    | Validated version-1 document → `204`. Keys: `appearance`, `desktop`, `dock`, `menubar`, `windows`, `security`, `widgets`. Unknown keys return `404`; invalid documents return `400`. |
| `DELETE /preferences/:key` | Removes the current user's document → `204`. Security changes and resets are audited without document contents.                                                                      |

Schemas and bounds live in `packages/shared/src/schemas/preferences.ts`. Theme and wallpaper data
are never executable. The web client queues writes per document, debounces edits, retries failures,
and waits for pending writes before logout. Failed initial loads show a retry screen rather than
replacing saved preferences. Resetting in the UI saves defaults through the same ordered queue.

## Wallpapers (`preferences:manage`, owner only)

| Method & path               | Description                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /wallpapers`           | `{ wallpapers: WallpaperInfo[] }` for the current user.                                                                                                                                                                         |
| `POST /wallpapers`          | Raw JPEG, PNG or WebP body with its MIME `Content-Type`; `201` with `WallpaperInfo`. Metadata is inspected from image bytes. Uploads stream to disk with a 10 MiB cap, 8192-pixel edge cap, 20-file quota and free-space check. |
| `GET /wallpapers/:id/image` | Owned image, its inspected MIME, `nosniff` and `Cache-Control: private, max-age=31536000, immutable`. Unknown or other users' ids return `404`.                                                                                 |
| `DELETE /wallpapers/:id`    | Deletes the owned image and metadata → `204`; records an audit event.                                                                                                                                                           |

SVG and HTML uploads are rejected. Stored files live under `<dataDir>/wallpapers/<userId>/`;
deleting an account removes its uploaded assets. Raw image, file and backup uploads use their
own streaming limits instead of the 64 KiB JSON cap and still require the session CSRF token.

## Folder icons (`preferences:manage`, owner only)

`/folder-icons` supports list, raw upload, owned `/:id/image` reads and unused `/:id` deletion,
with the same ownership rules as wallpapers. Uploads accept PNG/WebP/JPEG, at most 2 MiB and
1024 pixels per edge, with a separate 20-icon quota. List returns `{ icons: WallpaperInfo[] }`.
Appearance documents can set a default `folderIcon` and up to 500 unique `folderIcons` by
`{ root, path, icon }`. Uploaded references must belong to the user; deleting a used icon returns
`409`. See [power and folder icons](power-and-folder-icons.md).

## Account (authenticated, self-service)

| Method & path                  | Description                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `PATCH /account`               | `{ displayName?, locale? }` → `PublicUser`.                                                             |
| `POST /account/password`       | `{ currentPassword, newPassword }` → `204`. Revokes all other sessions.                                 |
| `POST /account/totp/enroll`    | → `{ secret, otpauthUri }` (pending until confirmed).                                                   |
| `POST /account/totp/enable`    | `{ code }` → `{ recoveryCodes: string[] }` (shown once).                                                |
| `POST /account/totp/disable`   | `{ password, code }` → `204`. `409 TWO_FACTOR_ENFORCED` while the policy covers the account.            |
| `POST /account/recovery-codes` | `{ password }` → `{ recoveryCodes }`. Invalidates all previous codes.                                   |
| `GET /account/linux`           | Caller-linked Linux identity and explicit privilege state; see [Linux accounts](linux-accounts.md#api). |
| `POST /account/linux/unlock`   | `{ linuxPassword, duration? }` → `LinuxAccountStatus`. Explicit durations are account-wide.             |
| `POST /account/linux/lock`     | Empty/bodyless → `204`. Revokes caller's Linux verification across sessions.                            |

## Users (`users:manage`)

| Method & path                | Description                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /users`                 | `{ users: AdminUserView[] }`.                                                                                                              |
| `POST /users`                | `{ username, displayName, password, role, locale? }` → `201` with `AdminUserView`. Returns `USER_USERNAME_TAKEN` (409) if the name exists. |
| `PATCH /users/:id`           | `{ displayName?, role?, disabled? }`. Disabling revokes the user's sessions. Errors: `USER_CANNOT_MODIFY_SELF`, `USER_LAST_ADMIN`.         |
| `POST /users/:id/password`   | `{ newPassword }` → `204`. Revokes the user's sessions.                                                                                    |
| `POST /users/:id/totp/reset` | Removes another user's 2FA (lost device) → `204`.                                                                                          |
| `DELETE /users/:id`          | → `204`. You cannot delete yourself or the last active administrator.                                                                      |

## Security policy (`users:manage`)

| Method & path              | Description                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /security/two-factor` | `{ required: "nobody" \| "admins" \| "everyone", pending }`: who must use 2FA and the active accounts it covers that have not set it up. |
| `PUT /security/two-factor` | `{ required }` → the same view; audited. `409 TWO_FACTOR_SELF_FIRST` when it would cover your own role while you have no second factor.  |

## HTTPS (`system:manage`)

| Method & path              | Description                                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /https`               | `HttpsView`: EveryOS's Tailscale Serve address, and the local-network listener (port, listening, error, addresses, authority and certificate fingerprints).                                                                       |
| `PUT /https/tailscale`     | `{ enabled }`: adds or removes EveryOS's own Serve handler (sudo-unlocked Linux account). Refusals are `409 CONFLICT` with `details.reason` (`not-running`, `https-disabled`, `port-in-use`, `funnel`, `api-not-on-loopback`, …). |
| `PUT /https/lan`           | `{ enabled, port }`: starts, moves or stops the HTTPS listener; a taken port is reported in `lan.error`.                                                                                                                          |
| `GET /https/authority.crt` | Any signed-in person: the local certificate authority (PEM) to install on devices.                                                                                                                                                |

## Audit (`audit:read`)

| Method & path | Description                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /audit`  | Query `limit` (1–200, default 50), `before` (cursor id), `action`. Returns `{ events, nextCursor }`. |

## System (`system:read`)

`GET /system/power` returns real Linux battery and power supply readings (`PowerStatus`). No
query parameters are accepted. Missing sensors/readings stay unavailable/null; measured watts
and reported input limits are separate. See [power and folder icons](power-and-folder-icons.md).

Agent errors map to stable codes on every host endpoint: `AGENT_UNAVAILABLE` (503),
`AGENT_TIMEOUT` (504), `AGENT_OPERATION_DENIED` (403, `details.reason` carries the agent's policy
reason, prefixed `PROTECTED_UNIT:`, `PROTECTED_CONTAINER:` or `DEVELOPMENT_MODE:`), `HOST_CAPABILITY_UNAVAILABLE` (501, e.g.
no systemd/journald), `NOT_FOUND` (404), `RATE_LIMITED` (429, too many concurrent agent streams) and
`AGENT_OPERATION_FAILED` (502).

| Method & path                    | Description                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /system/info`               | Host information (`SystemInfo`: hostname, OS, kernel, architecture, CPU, memory, uptime, hardware model, capability map with reasons).                                                              |
| `GET /system/metrics`            | Latest `MetricsSnapshot` (derived rates: CPU %, memory, swap, load, network/disk bytes per second, temperatures, per-core usage, fans). Sampled on demand when the last snapshot is older than 5 s. |
| `GET /system/metrics/history`    | Query `range` = `15m` (live resolution) \| `1h` (1-minute averages) \| `24h` (5-minute averages). Returns `{ range, resolutionMs, points }`. In-memory only: history restarts with the API.         |
| `GET /system/storage`            | Mounted data file systems with size, usage and inodes (`statfs`, 2 s timeout per mount).                                                                                                            |
| `GET /system/hardware`           | Raspberry Pi throttling flags (firmware `get_throttled`) and NVMe SMART health (`smartctl`), each with an availability reason.                                                                      |
| `GET /system/network`            | Interfaces (kind, state, MAC, MTU, speed, addresses), default gateways, DNS servers and internet reachability (TCP probe, cached for 60 s, configurable in `agent.yaml`).                           |
| `GET /system/tailscale`          | Tailscale state through the local LocalAPI socket (never the network).                                                                                                                              |
| `GET /system/tailscale/overview` | Status, this node in detail, Serve/Funnel handlers, remote-access analysis and warnings ([tailscale.md](tailscale.md)).                                                                             |
| `GET /system/tailscale/peers`    | `system:manage`: the tailnet's other devices.                                                                                                                                                       |
| `GET /system/disks`              | Disks and volumes with mount state; mounting and removal need `system:manage` ([disks.md](disks.md)).                                                                                               |
| `GET /system/power/reboot`       | Whether installed updates need a restart (`flag`, `kernel`), with the packages; restart and shutdown need `system:manage` ([updates.md](updates.md#restart-and-shutdown)).                          |
| `GET /system/processes`          | Query `sort` = `cpu` \| `memory`, `limit` 1–500 (default 50). CPU % is measured over 500 ms. Full command lines are only returned to roles with `system:manage`; others see the process name.       |

## Services

| Method & path                  | Permission        | Description                                                                                                                                                                                                       |
| ------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /services`                | `services:read`   | All systemd service units with load/active/sub state, unit-file state and the `protected` flag.                                                                                                                   |
| `GET /services/:unit`          | `services:read`   | Unit detail (main PID, active since, memory, CPU time, tasks, restarts, unit file, restart policy, type). Unit names are validated (`*.service` etc., no paths or options).                                       |
| `POST /services/:unit/actions` | `services:manage` | Body `{ "action": "start" \| "stop" \| "restart" \| "reload" \| "enable" \| "disable" }` → `202 { accepted: true }`. Submitted with `--no-block`; poll the detail for the result. Audited as `services.<action>`. |

Protected units (SSH, Tailscale, EveryOS itself, D-Bus, networking, `systemd-*`, gettys, user
managers, plus any configured in `agent.yaml`) accept only `start`, for every role. `stop`,
`restart`, `reload`, `enable` and `disable` are refused, so their boot configuration never changes
(Ubuntu's `ssh.service`, for example, is socket-activated through `ssh.socket`).

## Logs (`logs:read`)

| Method & path      | Description                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /logs`        | journald entries, newest first. Query `unit`, `priority` (0–7, this level and more severe), `since`/`until` (epoch ms), `grep` (≤ 200 chars, case-insensitive), `limit` (1–1000, default 200), `before` (cursor of the oldest entry already shown). Returns `{ source, entries, hasMore }`. |
| `GET /logs/stream` | Server-sent events of new entries (`event: entry`, `id` = journal cursor). Same `unit`, `priority`, `grep` filters. The agent ends a stream after one hour (`event: end`); EventSource reconnects automatically.                                                                            |

## Event stream

`GET /events?topics=metrics,docker` opens one multiplexed server-sent event stream per tab. Each
topic requires its own permission (`metrics` → `system:read`, `docker` → `docker:read`, `disks` →
`system:read`, `transfers` → `files:read`). Events:
`ready`, `metrics` with a `MetricsSnapshot` every 2 s, `docker.stats` with a `DockerStatsSnapshot`
every 5 s, and `docker.change` with a lifecycle notification. Sampling runs while subscribed.
A slow client receives the latest pending snapshot/notification instead of an unbounded queue;
clients refetch inventories on changes and reconnects.

**Widget data topics** can be added to the same stream: `data.system`, `data.storage`,
`data.network`, `data.tailscale`, `data.processes`, `data.hardware`, `data.services`,
`data.timers`, `data.sockets`, `data.apt`, `data.docker`, `data.alerts` and
`data.integration.<id>.<feed>` (at most 64 topics per stream). They arrive as `event: data` with a
`TopicMessage` (`{ topic, at, status: "ok", data }`, `{ …, status: "unavailable", reason }` or
`{ …, status: "error", code }`). Unknown topics and topics the user may not read produce an
`error` message for that topic only (`NOT_FOUND`, `FORBIDDEN`). Delivery is "latest wins" per topic.
Permissions, intervals and payloads are listed in [widgets.md](widgets.md#3-data-topics).

Every stream (`/events`, `/logs/stream`, Docker logs) re-checks access every 15 s without extending the session:
it closes when the session is locked, revoked or expired, the account is disabled, or the role no
longer grants the permission. Opening a stream from a locked session returns `423`.

## App Store

All route parameters, queries and bodies are strict. Mutations require CSRF and an unlocked
session. Catalog management is administrator-only; installed provenance survives source removal.

| Method & path                               | Permission        | Description                                                                                                                                                                      |
| ------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /catalogs`                        | `catalogs:manage` | List/add sources; input `{name, url, format?, allowPrivate?}`.                                                                                                                   |
| `PATCH/DELETE /catalogs/:id`                | `catalogs:manage` | Enable/disable with `{enabled}` or remove with `{}`.                                                                                                                             |
| `POST /catalogs/:id/sync`                   | `catalogs:manage` | `{}`; atomically sync or preserve the old snapshot on failure.                                                                                                                   |
| `GET /catalogs/apps`                        | `apps:read`       | Metadata, variables, ports/mounts, risks/blockers and duplicate identities; never rendered Compose or secrets.                                                                   |
| `GET /catalogs/apps/:id/icon`               | `apps:read`       | Authenticated raster icon proxy.                                                                                                                                                 |
| `GET /catalogs/apps/:id/screenshots/:index` | `apps:read`       | Cached raster screenshot, index 0–11.                                                                                                                                            |
| `GET /apps`                                 | `apps:read`       | Real container state, provenance, image identities, launch ports and persisted latest job.                                                                                       |
| `POST /apps/install`                        | `apps:manage`     | `{appId, snapshot, variables, ports, acknowledgeRisks, dataFrom?, confirmDataFrom?}` → `202 AppJobView`; host-access risks additionally require admin.                           |
| `POST /apps/:id/actions`                    | `apps:manage`     | `{action: start/stop/restart/update/remove/retry, confirmId?}` → `202 AppJobView`; every action except start requires exact ID confirmation. Risky update/retry requires admin.  |
| `GET /apps/:id/configuration?target=`       | `apps:manage`     | Settings form of an installed app (`current` or the catalog's newer `update`); secret values are never returned.                                                                 |
| `POST /apps/:id/configure`                  | `apps:manage`     | `{target, variables, ports, acknowledgeRisks, confirmId}` → `202 AppJobView`; blank secrets keep the stored ones. See [app-store.md](app-store.md#settings-and-catalog-updates). |
| `POST /apps/:id/reconcile`                  | `apps:manage`     | `{}`; reconcile only the exact interrupted agent job; return ownership/busy/latest job.                                                                                          |
| `GET /apps/jobs/:id`                        | `apps:read`       | Persisted progress, safe error and explicit rollback outcome.                                                                                                                    |
| `GET /apps/jobs/:id/events`                 | `apps:read`       | Read-only SSE `progress`/`end`; session/permission checks continue during the stream.                                                                                            |

See [app-store.md](app-store.md) for generators, data-copy limits, unsupported formats and rollback
semantics. Launch links and successful job outcomes do not promise application-level data rollback.

## Application integrations (widgets)

Credentials are write-only: responses carry `hasCredentials`, never the secret. Every mutation and
quick-control action is audited, and invalidates the integration's data topics.

| Method & path                    | Permission             | Description                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /integrations`              | `apps:read`            | `{ integrations: IntegrationView[] }`, filtered by audience: `managers` integrations are listed only with `apps:manage`.                                                                                                                                                                                  |
| `POST /integrations`             | `apps:manage`          | `{ adapter, name, appId?, baseUrl?, audience?, secret?, username?, options? }` → `201 IntegrationView`. `baseUrl` is http(s) without user info. `options`: Home Assistant `entityScope`/`controlScope` (`selected` or `all`) plus `entities`/`controlEntities`, PostgreSQL `container`/`user`/`database`. |
| `PATCH /integrations/:id`        | `apps:manage`          | Partial update; `secret` replaces the stored credential, `clearSecret: true` removes it.                                                                                                                                                                                                                  |
| `DELETE /integrations/:id`       | `apps:manage`          | Deletes the integration and its sealed credential → `204`.                                                                                                                                                                                                                                                |
| `POST /integrations/:id/test`    | `apps:manage`          | Runs the adapter once → `{ status: "ok" }`, `{ status: "unavailable", reason }` (e.g. `auth-failed`, `app-offline`) or `{ status: "error", code }` (e.g. `UNSAFE_ADDRESS`).                                                                                                                               |
| `GET /integrations/:id/states`   | `apps:read` + audience | Fresh Home Assistant states: `{ status, data?, reason?, code?, at }`. Access and scope are checked again after collection.                                                                                                                                                                                |
| `POST /integrations/:id/actions` | `apps:manage`          | Strict single-entity fixed action → `{ accepted: true }`. Integration scopes, fresh capabilities, numeric ranges and option membership are enforced; unlocking requires `confirm: true`. See [Home Assistant action payloads](home-assistant.md).                                                         |

`GET /apps` and `GET /catalogs/apps` include `widgetAdapters`: built-in adapters matched from the
deployed (or declared) image repositories.

## Docker

Routes reject unknown query/body fields. Queries are empty except for logs; image/network/import
deletion accepts no body. Identifiers are validated before reaching the agent. Resource conflicts
map to `CONFLICT` (409). Mutations and import changes are audited.

| Method & path                          | Permission                  | Description                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /docker`                          | `docker:read`               | Engine availability/reason, versions, counts, Compose availability and source.                                                                                                                                                                                                                                                  |
| `GET /docker/containers`               | `docker:read`               | Includes stopped containers, ports, health, project, protection and ownership.                                                                                                                                                                                                                                                  |
| `GET /docker/containers/:id`           | `docker:read`               | Detail, mounts, limits, risks, sanitized health output/labels and environment names only. Command/entrypoint requires `docker:manage`.                                                                                                                                                                                          |
| `POST /docker/containers/:id/actions`  | `docker:manage`             | `{ action: "start" \| "stop" \| "restart" }` → `202 { accepted: true }`. Protected containers accept only start.                                                                                                                                                                                                                |
| `GET /docker/containers/:id/logs`      | `docker:read` + `logs:read` | SSE line/end/error events. Query tail 0–5000 (default 200), follow true/false (default false), since epoch ms. Error carries `{ code }`; maximum duration one hour.                                                                                                                                                             |
| `GET /docker/containers/:id/stats`     | `docker:read`               | `{ id, resolutionMs, points }`: in-memory history, initially empty. Use a full container ID.                                                                                                                                                                                                                                    |
| `GET /docker/stats`                    | `docker:read`               | Latest rates; samples on demand if older than 10 s.                                                                                                                                                                                                                                                                             |
| `GET /docker/images`                   | `docker:read`               | Tags, size, dangling status and container references.                                                                                                                                                                                                                                                                           |
| `DELETE /docker/images/:id`            | `docker:manage`             | Removes only an unused image, without force.                                                                                                                                                                                                                                                                                    |
| `GET /docker/volumes`                  | `docker:read`               | Volumes, sizes when measurable and container references.                                                                                                                                                                                                                                                                        |
| `DELETE /docker/volumes/:name`         | `docker:delete`             | Admin only; `{ confirmName }` must equal the name. Refuses in-use volumes; permanently deletes data.                                                                                                                                                                                                                            |
| `GET /docker/networks`                 | `docker:read`               | Drivers, subnets and references.                                                                                                                                                                                                                                                                                                |
| `DELETE /docker/networks/:id`          | `docker:manage`             | Removes unused networks without force. Built-in bridge/host/none cannot be removed.                                                                                                                                                                                                                                             |
| `GET /docker/projects`                 | `docker:read`               | Discovered projects plus imports without containers.                                                                                                                                                                                                                                                                            |
| `POST /docker/projects/:name/import`   | `docker:manage`             | `{ acknowledgeManager?: boolean }` → 201. Validates discovered Compose files and records import. Another manager hint requires true. Changes no Docker resources.                                                                                                                                                               |
| `DELETE /docker/projects/:name/import` | `docker:manage`             | Forgets import; changes no containers/files/volumes.                                                                                                                                                                                                                                                                            |
| `POST /docker/projects/:name/actions`  | `docker:manage`             | `{ action: "up" \| "start" \| "stop" \| "restart" \| "update" \| "down" }` → `{ ok, output }`. Imported projects only; agent revalidates files/protection. A project containing a protected container accepts only start. Update pulls then recreates; down keeps volumes/images. `ok: false` reports a failed Compose command. |

## Phase 7 tools

File deletion moves items to private per-user trash. `GET /files/trash` lists the caller's items;
`POST /files/trash/restore { root, ids }` restores them without overwriting original names, and
`POST /files/trash/delete { root, ids, confirm: true }` deletes them permanently. Reading requires
`files:read`; both mutations require `files:write` and are audited. Backups include existing
EveryOS homes and trash; restore accepts an additional `homes: true` selection, with the normal
restore permission, password, confirmation and safety backup.

Each module has its own document with the full contract; all routes are strict about unknown
fields, require CSRF for changes, and audit every change.

| Area          | Routes                                                                                                                                                                                                                                                | Permission                                                                                 | Details                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Notifications | `GET /notifications`, `POST /notifications/{read,unread,dismiss}`                                                                                                                                                                                     | `notifications:read` (per-kind permission filters the list)                                | [notifications.md](notifications.md)                   |
| Files         | `GET /files/{roots,list,properties,search,text,download}`, `PUT /files/text`, `POST /files/{upload,mkdir,rename,copy,move,delete}`                                                                                                                    | `files:read`, changes `files:write`                                                        | [files.md](files.md)                                   |
| Updates       | `GET /updates`, `GET /updates/packages/:name`, `GET /updates/jobs[/:id[/events]]`, `POST /updates/{refresh,upgrade}`                                                                                                                                  | `system:read`, changes `system:manage`                                                     | [updates.md](updates.md)                               |
| Tasks         | `GET/POST /tasks`, `PATCH/DELETE /tasks/:id`, `GET /tasks/:id/runs`, `POST /tasks/:id/{run,cancel}`                                                                                                                                                   | `tasks:manage` plus the task type's permission                                             | [tasks.md](tasks.md)                                   |
| Backups       | `GET/POST /backups`, `POST /backups/cancel`, `PUT /backups/settings`, `/backups/:id/{verify,pin,preview,restore,download,offsite}`, `POST /backups/upload` (+ `/upload/:id/decrypt`), `/backups/{encryption,offsite,secret-key}`                      | `backups:manage`; restore, download and upload `backups:restore` with the current password | [backups.md](backups.md)                               |
| Tailscale     | `GET /system/tailscale/overview`, `GET /system/tailscale/peers`                                                                                                                                                                                       | `system:read`; devices `system:manage`                                                     | [tailscale.md](tailscale.md)                           |
| Disks         | `GET /system/disks`, `POST /system/disks/{mount,unmount}`                                                                                                                                                                                             | `system:read`, changes `system:manage` and sudo                                            | [disks.md](disks.md)                                   |
| Power         | `GET /system/power/{reboot,blockers}`, `POST /system/power`                                                                                                                                                                                           | `system:read`, blockers and actions `system:manage` and sudo                               | [updates.md](updates.md#restart-and-shutdown)          |
| Channels      | `GET/POST /notification-channels`, `PUT/DELETE /notification-channels/:id`, `POST /notification-channels/:id/test`                                                                                                                                    | `system:manage`                                                                            | [notifications.md](notifications.md#external-channels) |
| Drive         | `GET/PUT/DELETE /drive/client`, `GET/DELETE /drive/account`, `POST /drive/connect[/complete]`, `GET /drive/files`, `POST /drive/{folders,upload,transfers}`, `PATCH /drive/files/:id`, `POST /drive/files/:id/trash`, `GET /drive/files/:id/download` | client `system:manage`; reading `files:read`; changes `files:write`                        | [drive.md](drive.md)                                   |
| Transfers     | `GET/DELETE /transfers`, `POST /transfers/:id/cancel`                                                                                                                                                                                                 | `files:read`, own transfers only                                                           | [transfers.md](transfers.md)                           |
| Terminal      | `GET /terminal/status`, `GET /terminal/sessions`, `DELETE /terminal/sessions/:id`, WebSocket `GET /terminal/ws`                                                                                                                                       | `terminal:access` (administrators); deletion also checks ownership or `users:manage`       | [terminal.md](terminal.md)                             |

Home Assistant device metadata joins the device/entity/area WebSocket registries; see
[the integration guide](home-assistant.md). `GET /api/integrations/:id/brand/:brand` requires
`apps:read` and the integration audience. It returns only a bounded PNG from the fixed brand
allowlist, without forwarding Home Assistant credentials.
