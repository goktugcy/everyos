# Calendar

EveryOS's calendar (`dev.everyos.calendar`). Everything is stored in EveryOS for each person; no
external calendar service is needed or contacted.

## What it does

- **Day, week and month views**, a "Today" button, previous and next, and a date to jump to. The
  week starts on the day usual for your language, or the one you choose. Today's column shows the
  current time.
- **Events**: title, all-day or start and end times, location, notes, calendar. Click an event
  to change or delete it; double-click a day in the month view, or click an empty time in the day
  and week views, to add one there. Overlapping events share the width of their day.
- **Repeating events**: every day, weekday, week, month (on the same day or the same weekday,
  such as the third Tuesday or the last Friday), year, or a custom rule (every N days, weeks,
  months or years, on chosen weekdays, ending never, on a date or after N times). Changing or
  deleting one occurrence asks whether it is for this event, this and following events, or all
  of them. Rules made by other calendars that this dialog cannot show are kept as they are.
- **Time zones**: an event keeps the time zone it was made in, so "every Monday at 09:00" stays
  at 09:00 across daylight-saving changes, and events from elsewhere appear at the right time in
  yours.
- **Reminders**: up to five per event (at the start, minutes, hours, days or a week before; for
  all-day events at 09:00 on the day or days before), sent as EveryOS notifications while the
  Calendar window or its widget is open. A reminder missed while EveryOS was closed still comes
  if the event has not ended.
- **Search** titles, places and notes of all calendars; results open the event.
- **Calendars**: several, each with a name and colour, shown or hidden; deleting one deletes its
  events after asking.
- **iCalendar (.ics)**: import into a new calendar or an existing one (importing the same file
  again updates its events instead of doubling them), with time zones (IANA and common Windows
  names), repeat rules, exceptions, changed occurrences and alarms. Export a calendar to `.ics`
  for other calendar apps; time zones are written by their IANA names.
- **Upcoming events widget** for the desktop or the sidebar: the next events of the coming week;
  click one to open it in the Calendar.
- **Keys** (outside text fields): T today, D/W/M day, week, month, N new event, ← → previous and
  next, / search.

## Permissions

| Capability           | Why                                      |
| -------------------- | ---------------------------------------- |
| `storage:app`        | Calendars, events, the view and settings |
| `notifications:send` | Reminders                                |
| `widgets:register`   | The Upcoming events widget               |
| `files:pick`         | Importing `.ics` files                   |
| `files:save`         | Exporting a calendar to `.ics`           |

## Storage

| Key                      | Value                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| `calendars`              | Name, colour and visibility of each calendar                             |
| `events/0` … `events/15` | Events, spread over 16 values (each value holds up to 256 KB)            |
| `view`, `sidebar`        | The open view, whether the calendar list is shown                        |
| `settings`               | First day of the week                                                    |
| `reminded`               | Reminders already sent (the last 500)                                    |
| `window`                 | When a Calendar window was last open (the widget leaves reminders to it) |

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/calendar
cd official-apps/calendar && pnpm exec everyos-app validate
```
