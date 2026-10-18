# Notification center (Phase 7)

Notifications are stored in SQLite and shown per user. Each notification is visible to everyone
holding its kind's permission, or only to one user when `user_id` is set. Read and dismissed states
are per user (`notification_states`), so one person reading or clearing a notification never
affects anyone else.

## Kinds

`NOTIFICATION_KINDS` (`packages/shared/src/notifications.ts`) defines every kind with its category
and the permission needed to see it. Texts are rendered by the client from `kind` and `params`
(`notifications.kinds.<kind>.title/body`), so stored notifications stay localizable.

- **Conditions** (`condition: true`) describe a state that lasts:
  - failed service, low disk space, container with problems;
  - under-voltage, throttling, NVMe health;
  - pending security updates, a restart required by installed updates (`reboot-required`), a
    newer catalog definition for an installed app (`app-update-available`);
  - internet offline, Tailscale offline, Tailscale key expiring, EveryOS public through Tailscale
    Funnel ([tailscale.md](tailscale.md)), agent unreachable.

  `raise()` creates one notification. While the condition stays open, later calls are no-ops,
  except that a worse severity alerts again and fresh parameters update silently. `resolve()`
  marks it resolved, and the UI shows "resolved".

- **Events** are one-off: app job results, update results, backup and task results, login
  lockouts. `publish()` merges the same event within one hour into one notification with a
  count, marks it unread again, and pops it up again at most every 15 minutes.

Retention: 30 days, and at most 2,000 notifications. Open conditions are kept.

## Sources

| Source                                       | Kinds                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `HostMonitor` (API, every 2 min, after 20 s) | service, storage, container, hardware and security-update conditions; internet (two failed checks), Tailscale, agent (two checks)  |
| `AppService` job completion                  | `app-succeeded`, `app-failed` (app name, action, reason, rollback)                                                                 |
| Login limiter                                | `login-locked` when an account or address becomes locked (`audit:read`)                                                            |
| `HostMonitor` Tailscale checks               | `tailscale-key-expiry` (`system:read`), `tailscale-funnel` (`system:manage`, security)                                             |
| Phase 7 modules                              | updates ([updates.md](updates.md)), backups ([backups.md](backups.md)) and scheduled tasks ([tasks.md](tasks.md))                  |
| `HostMonitor` restart and app checks         | `reboot-required` (packages, kernel), `app-update-available` per installed app (catalog definition changed)                        |
| Power route                                  | `power-scheduled` when an administrator restarts or shuts down the host                                                            |
| Disk watcher (`DiskService`)                 | `disk-attached` (administrators; mounted by itself or not), `disk-detached` for every removed disk (a warning when it was mounted) |
| Transfers                                    | `transfer-succeeded`, `transfer-failed` for the person's own transfers that ran 20 s or more, or failed                            |

The monitor reuses the agent's cached collectors (`collectAlerts`). It resolves a condition only
when the source that reports it answered: a failing check never clears a real problem.

## Delivery

- **API:**
  - `GET /api/notifications` takes `severity`, `category`, `unread=true`, `limit` (1–200) and an
    opaque `before` cursor. It returns the notifications plus the unread counts per category.
  - `POST /api/notifications/{read,unread,dismiss}` takes `{ ids }` or `{ all: true }`.
  - Every route requires `notifications:read`, and the changes only affect the caller.
- **Live:** `notifications` is a stream topic on the per-tab event stream (`/api/events`). It sends
  `event: notifications` with `{ unread, latest }` when it opens and on every visible change.
  `latest` is set only when the notification should pop up. Events are delivered in order, with
  at most 20 queued per stream.
- **Providers:** the `NotificationProvider` interface (`deliver(notification)`) is the extension
  point for delivery outside the app. The built-in log provider writes new notifications to the
  service log (journald); the channel provider sends them to [external channels](#external-channels).
  Providers get only new or re-alerted notifications, and a failing provider never affects the
  in-app center.

## External channels

Administrators (`system:manage`) add up to 10 channels in Settings › Notifications:

| Kind     | Settings                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ntfy     | Server (default `https://ntfy.sh`), topic, optional access token. Published as JSON, so non-ASCII titles survive.                  |
| Telegram | Bot token and chat id. Plain text without a parse mode, so notification text never becomes markup.                                 |
| E-mail   | SMTP host, port, `tls` (465), `starttls` (587) or `none`, optional user and password, sender and up to 10 recipients (nodemailer). |
| Webhook  | URL, optional bearer token and format: `discord` (mentions disabled), `slack` (escaped) or `json` (the full notification).         |

Each channel has a language (`tr`/`en`; texts are rendered on the server from the same
resources as the app), a minimum severity and optional categories (none means all). Only
notifications without a `user_id` leave the server: personal ones stay in the app.

The bot token, SMTP password, access tokens, the ntfy topic and the webhook URL work like
credentials. They are sealed with SecretBox (`notify-channel:<id>:config:v1`) and never returned:
the list shows a topic hint, the webhook's origin and whether a secret is stored. An update that
omits a credential keeps the stored one; `clearToken`/`clearPassword` remove an optional one.
Webhook URLs may carry a query string but no user information. Audit entries name the channel and
kind, never the secrets.

Subscribing a phone needs the exact ntfy topic, so **Add to phone** asks for it separately
(`GET /api/notification-channels/:id/ntfy-topic`, administrators only, audited as
`notifications.channel.topic`) and shows the server, the topic and a QR code of
`<server>/<topic>`, which the ntfy apps and web app open. After a test message the panel points
there in case nothing arrived: topics are case-sensitive, and iPhones get instant notifications
from a self-hosted server only when it sets `upstream-base-url: "https://ntfy.sh"`.

Requests use the integrations HTTP client: DNS is resolved once and pinned (SMTP connects to the
pinned address while TLS still checks the configured name), redirects are not followed, link-local
and cloud metadata addresses are refused, and requests time out after 10 s. Private addresses are
allowed for self-hosted ntfy, mail and webhook servers.

A channel sends at most 20 messages per ten minutes; the rest is dropped and logged. The last
delivery time and the last failure's short, credential-free reason (`http-status-401`,
`http-timeout`, `smtp-auth`…) are shown on the channel. **Send test message** delivers a fixed
message in the channel's language and reports `CHANNEL_DELIVERY_FAILED` with the reason.

| Method & path                          | Description                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /notification-channels`           | Channel views, without secrets.                                                       |
| `POST /notification-channels`          | Create; `{ kind, name, enabled, minSeverity, categories, language, …kind settings }`. |
| `PUT /notification-channels/:id`       | Replace; omitted credentials keep the stored ones.                                    |
| `DELETE /notification-channels/:id`    | `{ confirmId }` equal to the id.                                                      |
| `POST /notification-channels/:id/test` | Send a test message now.                                                              |

## Client

The menu bar bell (module `notifications`) shows the unread count without muted categories. On
phones the bell sits in the header of the mobile shell, and dismiss buttons are always visible on
touch screens. The center offers:

- all and unread filters, plus severity and category filters;
- grouping by category;
- mark all read, dismiss one or clear all;
- older pages;
- deep links to the related app (opened only when the user may open that app).

Pop-ups appear at the top right. Critical ones stay until closed; others disappear after 8 s.
Disk notices (`ANNOUNCED_KINDS`) pop up whatever the minimum severity, and every time, because
they answer what the person just did. The preference document `notifications` holds `toasts`,
`toastMinSeverity` (default: warning) and `mutedCategories`. Muted categories stay listed, but are not counted and never pop up.

## EveryOS version updates

`ReleaseMonitor` starts in production 20 seconds after the API starts. Every minute it reads
`release.status` from the agent. When the persisted successful check is at least one hour old,
it requests `release.check`; failed remote checks back off for 15 minutes. Concurrent monitor
checks share one request, and shutdown cancels pending work. Cached metadata is already verified
by the existing release manager; invalid signatures and unavailable sources never create an
invented update. Background calls allow the system actor only for these two read operations;
`release.install` still requires the authorized administrator session, explicit confirmation and verified safety backup.

A newer available version raises `everyos-update-available` in the **updates** category, visible
to users with `system:read` (plus notification access). Warning severity makes it eligible for
the existing default toast threshold; muted categories and toast preferences remain respected.
The version is the durable condition key, so polling, reading/dismissing and API restarts do not
repeatedly alert for the same pending version. A newer release resolves the previous condition,
and installing/upgrading to the candidate resolves it. Clicking the notification opens Settings
→ About. It never begins a download or installation.

The About status/check endpoints observe the same condition immediately, so a manual successful
check updates the center too. Development/non-Linux/unconfigured status does not produce release
notifications. This reuses the configured signed release source and publisher key; it does not
fetch an independent or untrusted version feed.

Version discovery reaches open About/EveryOS update panels through the `release` event topic
(`release.status`), authorized with `system:read`. The monitor replays its verified snapshot and
publishes changed snapshots; identical reads do not rebroadcast. Installed version, available
version, check time and job state remain real agent values. Panels refresh after reconnection and
retain their three-second read-only polling fallback. Live/check results abort older pending reads,
so a delayed response cannot overwrite a newer result. No release event installs an update.

Notification subscriptions belong to the authenticated shell, independently of bell visibility or
screen size. On reconnect, return from a hidden tab or restored network, the shell reads pending
unread EveryOS version notices using the existing permissioned notification list. A 30-second
internal polling fallback also works when event delivery is unavailable. This does not increase
the five-minute remote release-check cadence. Seen version notices are deduplicated within the session;
read, dismissed, resolved and muted notices do not produce catch-up pop-ups. Locks/sign-out abort
pending reads and clear displayed data; a different session cannot receive the preceding user's
response. Closed event connections cannot deliver late events into a replacement connection.

A notification-list response arriving while the document is hidden is discarded without marking
version notices as seen; returning to the tab reads them again before displaying the pop-up.
