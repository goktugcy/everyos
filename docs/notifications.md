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
  - pending security updates;
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

| Source                                       | Kinds                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `HostMonitor` (API, every 2 min, after 20 s) | service, storage, container, hardware and security-update conditions; internet (two failed checks), Tailscale, agent (two checks) |
| `AppService` job completion                  | `app-succeeded`, `app-failed` (app name, action, reason, rollback)                                                                |
| Login limiter                                | `login-locked` when an account or address becomes locked (`audit:read`)                                                           |
| `HostMonitor` Tailscale checks               | `tailscale-key-expiry` (`system:read`), `tailscale-funnel` (`system:manage`, security)                                            |
| Phase 7 modules                              | updates ([updates.md](updates.md)), backups ([backups.md](backups.md)) and scheduled tasks ([tasks.md](tasks.md))                 |

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
  point for external channels (Telegram, e-mail, web push). The built-in log provider writes new
  notifications to the service log (journald). Providers get only new or re-alerted notifications,
  and a failing provider never affects the in-app center.

## Client

The menu bar bell (module `notifications`) shows the unread count without muted categories. The
center offers:

- all and unread filters, plus severity and category filters;
- grouping by category;
- mark all read, dismiss one or clear all;
- older pages;
- deep links to the related app (opened only when the user may open that app).

Pop-ups appear at the top right. Critical ones stay until closed; others disappear after 8 s. The
preference document `notifications` holds `toasts`, `toastMinSeverity` (default: warning) and
`mutedCategories`. Muted categories stay listed, but are not counted and never pop up.

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
the hourly remote release-check cadence. Seen version notices are deduplicated within the session;
read, dismissed, resolved and muted notices do not produce catch-up pop-ups. Locks/sign-out abort
pending reads and clear displayed data; a different session cannot receive the preceding user's
response. Closed event connections cannot deliver late events into a replacement connection.
