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
