# To-Do

EveryOS's task manager (`dev.everyos.todo`): projects, priorities, due dates and times, repeating
tasks, tags, subtasks, reminders, a progress overview and a widget for today's tasks.

## What it does

- **Lists**: Inbox (tasks without a project), Today (due today or overdue), Upcoming (the next 7
  days), Overdue, All and Completed; your projects (colored, renamed or deleted — their tasks then
  move to the Inbox); and every tag in use.
- **Tasks**: title, notes, priority (none, low, medium, high), due date and time, tags (typed as
  `#tag` when adding), subtasks (checked and reordered), completion with a way back, deletion
  with a confirmation. Sort by your own order (Alt+↑/↓ or the arrow buttons), due date, priority
  or title. Search looks in titles, notes, tags and subtasks.
- **Repeating tasks**: daily or every n days, weekdays, weekly on chosen days every n weeks,
  monthly on the same day (the 31st becomes the last day of shorter months) or the same weekday
  (e.g. the 2nd Tuesday, or the last Friday), yearly (29 February becomes the 28th in other
  years). Completing one records it and moves the task to its next date, with its subtasks open
  again.
- **Reminders** at the due time or before it (09:00 when the task has no time), sent once per
  occurrence while EveryOS is open in a browser (this window or the widget). EveryOS cannot
  remind while no EveryOS page is open.
- **Progress**: today's and overdue counts, open tasks, completions of the last 7 days (chart)
  and done/total per project.
- **Today's tasks widget** (desktop and sidebar): check tasks off, add one for today, open one
  in the app.
- **Backups**: export everything to a JSON file and import it (tasks already present are kept).

Keyboard: Mod+N adds a task, Mod+F searches; on a task, Space completes it, Delete deletes it,
Alt+↑/↓ moves it.

## Permissions

| Capability                 | Why                                                 |
| -------------------------- | --------------------------------------------------- |
| `storage:app`              | Tasks and projects, per person (shared with widget) |
| `notifications:send`       | Reminders                                           |
| `widgets:register`         | The Today's tasks widget                            |
| `files:pick`, `files:save` | Importing and exporting backups                     |

## Storage

| Key                   | Value                                                 |
| --------------------- | ----------------------------------------------------- |
| `tasks/0` … `tasks/7` | Tasks, spread over shards by id                       |
| `projects`            | Projects (name, color, order)                         |
| `view`, `sort`        | The open list and the sort order                      |
| `reminded`            | Reminders already sent (the latest 500)               |
| `window`              | When the window last said it is open (for the widget) |

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/todo
cd official-apps/todo && pnpm exec everyos-app validate
```
