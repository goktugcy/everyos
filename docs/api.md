# HTTP API (Phases 1–2)

Base path: `/api`. Bodies are JSON except raw wallpaper uploads. JSON responses are never cached
(`Cache-Control: no-store`); owned wallpaper images use private immutable caching.

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
`X-Otuken-CSRF` header with the `csrfToken` from the session.

## Public

| Method & path           | Description                                                                                                                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`           | Readiness. Returns `200` with `{ status: "ok" \| "degraded", checks: { database, agent } }`, or `503` if the database is unreachable. Reveals no version or host details.                                                                                                                           |
| `GET /bootstrap`        | `{ product, version, setupRequired, defaultLocale, transport: { secure, loopback }, mode }`.                                                                                                                                                                                                        |
| `POST /setup`           | Only while no user exists. Body: `{ setupToken, username, displayName, password, locale }`. Returns `201` with `SessionInfo` and sets the session cookie. Errors: `SETUP_TOKEN_INVALID` (403), `SETUP_ALREADY_COMPLETED` (409), `AUTH_PASSWORD_POLICY` (400, `details.violations`), `RATE_LIMITED`. |
| `POST /auth/login`      | Body: `{ username, password }`. Returns `{ status: "authenticated", session }`, or `{ status: "totp_required", challengeId, expiresAt }`. Errors: `AUTH_INVALID_CREDENTIALS` (401), `AUTH_ACCOUNT_DISABLED` (403), `RATE_LIMITED` (429).                                                            |
| `POST /auth/login/totp` | Body: `{ challengeId, code }` or `{ challengeId, recoveryCode }`. Same success shape. Errors: `AUTH_TOTP_INVALID`, `AUTH_CHALLENGE_EXPIRED` (also returned when the challenge is used from a different IP).                                                                                         |

## Session (authenticated)

| Method & path               | Description                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /auth/session`         | `SessionInfo`: `{ user, permissions, csrfToken, session: { id, createdAt, expiresAt, locked } }`. |
| `POST /auth/logout`         | Revokes the current session and clears the cookie. Returns `204`.                                 |
| `GET /auth/sessions`        | `{ sessions: SessionSummary[] }` for the current user.                                            |
| `DELETE /auth/sessions/:id` | Revokes one of your own sessions. Returns `204`.                                                  |
| `POST /auth/lock`           | Locks only the current session on the server. Returns `204` and records an audit event.           |
| `POST /auth/unlock`         | `{ password }` → `SessionInfo`. Re-authentication is rate-limited and audited.                    |

Locked sessions receive `423 SESSION_LOCKED` for host/account reads and all mutations except
unlock and logout. Public health/bootstrap, session probing, preference reads and owned wallpaper
images remain readable so the lock screen can render across reloads. UI auto-lock is an inactivity
convenience; server idle/absolute session expiry remains the authentication boundary.

## Personal desktop preferences (`preferences:manage`)

All roles can customize their own desktop. This permission gives no authority over host or
instance settings, or another user's data. Ownership is always taken from the session.

| Method & path              | Description                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /preferences`         | `{ preferences: Partial<PreferenceDocuments> }`. Missing documents use client defaults. Unexpected query fields are rejected.                                             |
| `PUT /preferences/:key`    | Validated version-1 document → `204`. Keys: `appearance`, `desktop`, `dock`, `menubar`, `windows`, `security`. Unknown keys return `404`; invalid documents return `400`. |
| `DELETE /preferences/:key` | Removes the current user's document → `204`. Security changes and resets are audited without document contents.                                                           |

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
deleting an account removes its wallpapers. Wallpaper uploads are the only exception to the
64 KiB JSON body cap and still require the session CSRF token.

## Account (authenticated, self-service)

| Method & path                  | Description                                                             |
| ------------------------------ | ----------------------------------------------------------------------- |
| `PATCH /account`               | `{ displayName?, locale? }` → `PublicUser`.                             |
| `POST /account/password`       | `{ currentPassword, newPassword }` → `204`. Revokes all other sessions. |
| `POST /account/totp/enroll`    | → `{ secret, otpauthUri }` (pending until confirmed).                   |
| `POST /account/totp/enable`    | `{ code }` → `{ recoveryCodes: string[] }` (shown once).                |
| `POST /account/totp/disable`   | `{ password, code }` → `204`.                                           |
| `POST /account/recovery-codes` | `{ password }` → `{ recoveryCodes }`. Invalidates all previous codes.   |

## Users (`users:manage`)

| Method & path                | Description                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /users`                 | `{ users: AdminUserView[] }`.                                                                                                              |
| `POST /users`                | `{ username, displayName, password, role, locale? }` → `201` with `AdminUserView`. Returns `USER_USERNAME_TAKEN` (409) if the name exists. |
| `PATCH /users/:id`           | `{ displayName?, role?, disabled? }`. Disabling revokes the user's sessions. Errors: `USER_CANNOT_MODIFY_SELF`, `USER_LAST_ADMIN`.         |
| `POST /users/:id/password`   | `{ newPassword }` → `204`. Revokes the user's sessions.                                                                                    |
| `POST /users/:id/totp/reset` | Removes another user's 2FA (lost device) → `204`.                                                                                          |
| `DELETE /users/:id`          | → `204`. You cannot delete yourself or the last active administrator.                                                                      |

## Audit (`audit:read`)

| Method & path | Description                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /audit`  | Query `limit` (1–200, default 50), `before` (cursor id), `action`. Returns `{ events, nextCursor }`. |

## System (`system:read`)

| Method & path      | Description                                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /system/info` | Host information collected by the agent (`SystemInfo`: hostname, OS, kernel, architecture, CPU, memory, uptime, hardware model, capability map with reasons). Errors: `AGENT_UNAVAILABLE` (503), `AGENT_TIMEOUT` (504), `AGENT_OPERATION_DENIED` (403), `AGENT_OPERATION_FAILED` (502). |
