# Cron Builder

EveryOS's cron schedule builder (`dev.everyos.cron`): write or build an expression, read it in
plain language, see when it runs in any time zone, and take it to crontab, a systemd timer or
EveryOS's Scheduled Tasks. It never schedules anything itself.

## What it does

- **Expression** with five fields (minute, hour, day of month, month, day of week), or six with
  the optional seconds field. Numbers, `*`, lists, ranges, steps (`*/15`, `5-59/10`), month and
  weekday names (`JAN`, `MON-FRI`), 7 as Sunday, and `@yearly`, `@annually`, `@monthly`,
  `@weekly`, `@daily`, `@midnight`, `@hourly`. `@reboot` is recognized and explained (it has no
  times). Errors name the field and the value at fault.
- **Visual builder**: each field as "every", specific values, a range or every n starting at a
  value, kept in step with the expression both ways (forms the builder cannot show are edited in
  the expression).
- **Plain-language description** in the person's language (cronstrue).
- **Next 10 and previous 5 runs** in a chosen time zone (cron-parser), with daylight saving.
  Schedules that never run (30 February) say so.
- **Presets** for common schedules, and **saved expressions**.
- **Export**: a crontab line with your command; systemd `OnCalendar=` lines with the time zone
  (when both day fields are restricted, cron runs when either matches, so the timer gets two
  lines); a `.timer` file to save; and the numeric form EveryOS's Scheduled Tasks accept, with
  the reason when an expression does not fit them (seconds, or more often than every 5 minutes).

## Permissions

| Capability        | Why                                          |
| ----------------- | -------------------------------------------- |
| `storage:app`     | The expression, settings and saved schedules |
| `clipboard:write` | Copying expressions and exports              |
| `files:save`      | Saving a systemd `.timer` file               |

## Storage

| Key     | Value                                            |
| ------- | ------------------------------------------------ |
| `state` | Expression, seconds field, time zone and command |
| `saved` | Up to 100 named expressions                      |

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/cron
cd official-apps/cron && pnpm exec everyos-app validate
```
