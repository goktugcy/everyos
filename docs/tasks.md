# Scheduled tasks (Phase 7)

The **Scheduled Tasks** app (`everyos.tasks`) runs predefined, parameterized actions on a
schedule. There is no "run a command" task: a web form must never become an unrestricted way to
execute privileged commands.

## Task types

| Type                | Parameters  | Permission        | Action                                                              |
| ------------------- | ----------- | ----------------- | ------------------------------------------------------------------- |
| `updates.refresh`   | —           | `system:manage`   | Refreshes package lists (an update manager job)                     |
| `updates.security`  | —           | `system:manage`   | Upgrades the packages that have security updates                    |
| `service.restart`   | `unit`      | `services:manage` | Restarts a systemd unit (protected units are refused)               |
| `container.restart` | `container` | `docker:manage`   | Restarts a container by name                                        |
| `app.update`        | `appId`     | `apps:manage`     | Updates an EveryOS-managed app (with its image rollback)            |
| `backup.create`     | —           | `backups:manage`  | Creates a backup with the saved settings ([backups.md](backups.md)) |

Every type has a closed parameter schema; unknown fields are rejected. Each executor uses exactly
the same checks as the interactive feature (agent policy, protected units and containers, update
and backup job rules).

## Who a task runs as

A task belongs to the user who created it. **Every run uses the owner's current permissions**: if
the owner was demoted, disabled or deleted, runs fail with `owner-unauthorized` instead of acting
with former rights. Creating or editing a task requires the permission of its type plus
`tasks:manage`.

## Schedules

Five-field cron expressions in the server's local time (minute, hour, day of month, month, day of
week; lists, ranges and steps; `0` and `7` are Sunday). As in Vixie cron, when both day of month
and day of week are restricted, either may match. Schedules that would run more often than every
five minutes are refused (`too-frequent`). The app offers hourly, daily, weekly and monthly
presets and shows the next run before saving.

## Runner

- A clock checks due tasks every 30 seconds, independently of HTTP requests. The next run is
  computed before a run starts, so a long run is never repeated.
- One run per task at a time; a manual run while one is active answers `409`. Runs can be
  cancelled; the executor's own job (an update or backup) is cancelled with it.
- After a restart, runs that were in progress are marked `interrupted`. A run missed while EveryOS
  was down is caught up **once** if it was due within the last 12 hours and the task allows it
  (`catchUp`, default on); older ones are skipped and the task simply waits for its next time.
- History keeps the last 100 runs per task (trigger, status, timing, error code, short summary).
- Notifications: `task-failed` (default), every run (`always`) or never.
- Creating, editing, deleting, running and cancelling are audited (`tasks.*`), and so is every run
  (`tasks.run`, as the owner).

## API

| Method   | Path                    | Permission     | Notes                                                           |
| -------- | ----------------------- | -------------- | --------------------------------------------------------------- |
| `GET`    | `/api/tasks`            | `tasks:manage` | `{ tasks, types }` (types the caller may create)                |
| `POST`   | `/api/tasks`            | `tasks:manage` | `{ name, type, params, schedule, enabled?, notify?, catchUp? }` |
| `PATCH`  | `/api/tasks/:id`        | `tasks:manage` | `{ name?, schedule?, enabled?, notify?, catchUp? }`             |
| `DELETE` | `/api/tasks/:id`        | `tasks:manage` | Deletes the task and its history                                |
| `GET`    | `/api/tasks/:id/runs`   | `tasks:manage` |                                                                 |
| `POST`   | `/api/tasks/:id/run`    | `tasks:manage` | Runs now (as the owner)                                         |
| `POST`   | `/api/tasks/:id/cancel` | `tasks:manage` |                                                                 |
