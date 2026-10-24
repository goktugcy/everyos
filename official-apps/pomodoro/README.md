# Pomodoro

EveryOS's focus timer (`dev.everyos.pomodoro`): focus sessions with short and long breaks, a
session history, daily statistics, optional notifications and a desktop widget.

## What it does

- **Timer.** Focus, short break and long break (after a chosen number of focus sessions), with
  start, pause, resume, reset and skip. Durations and the long-break cadence are settings; breaks
  and focus sessions can start automatically.
- **Accurate after anything.** A running phase is stored as the time it ends, so the countdown is
  right after a reload, in a background tab or after the computer slept. Phases that ended while
  EveryOS was closed complete when it opens again (chained, when they start automatically).
- **Window and widget together.** The _Pomodoro timer_ widget (desktop and sidebar) shows and
  controls the same timer; changes in one appear in the other within two seconds.
- **History** of focus sessions (completed, or stopped early after at least a minute) with an
  optional label, and **statistics**: today, the last 7 days (chart) and the streak of days.
- **Notifications** when a phase ends, while EveryOS is open in a browser (the window or the
  widget). Window and widget never announce the same phase twice. EveryOS cannot notify while no
  EveryOS page is open.

Keyboard: Space start/pause, R reset, S skip.

## Permissions

| Capability           | Why                                                  |
| -------------------- | ---------------------------------------------------- |
| `storage:app`        | The timer, settings and history (shared with widget) |
| `notifications:send` | Tell the person a phase ended (a setting)            |
| `widgets:register`   | The Pomodoro timer widget                            |

## Storage

| Key        | Value                                                              |
| ---------- | ------------------------------------------------------------------ |
| `state`    | Phase, status, end time or time left, cycle, label, revision       |
| `settings` | Durations, long-break cadence, auto-start and notification choices |
| `history`  | Up to 1,000 focus sessions, newest first                           |
| `notified` | The last phase end announced (so it is announced once)             |
| `window`   | When the window last said it is open (the widget defers to it)     |
| `view`     | The open tab                                                       |

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/pomodoro
cd official-apps/pomodoro && pnpm exec everyos-app validate
```
