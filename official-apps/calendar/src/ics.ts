import { RRule } from "rrule";
import {
  addDays,
  addMinutes,
  dateOf,
  isTimeZone,
  toInstant,
  toWall,
  type LocalDate,
  type LocalDateTime,
} from "./dates.ts";
import { MAX_REMINDERS, MAX_TEXT, MAX_TITLE, newId, newUid, type CalendarEvent } from "./model.ts";

/*
 * iCalendar (RFC 5545) import and export: the events of one calendar, with their recurrence
 * rules, exceptions and reminders. Time zones are kept by their IANA names.
 */

export const MAX_ICS_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORTED = 5000;

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface Component {
  name: string;
  properties: Property[];
  children: Component[];
}

function unfold(text: string): string[] {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
}

function parseProperty(line: string): Property | null {
  let quoted = false;
  let colon = -1;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    else if (line[index] === ":" && !quoted) {
      colon = index;
      break;
    }
  }
  if (colon < 1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) ?? [];
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    if (equals > 0)
      params[part.slice(0, equals).toUpperCase()] = part.slice(equals + 1).replace(/^"|"$/g, "");
  }
  return { name: (parts[0] ?? "").toUpperCase(), params, value };
}

function parseComponents(text: string): Component[] {
  const root: Component = { name: "ROOT", properties: [], children: [] };
  const stack = [root];
  for (const line of unfold(text)) {
    const property = parseProperty(line);
    if (!property) continue;
    const current = stack.at(-1)!;
    if (property.name === "BEGIN") {
      const child = { name: property.value.toUpperCase(), properties: [], children: [] };
      current.children.push(child);
      stack.push(child);
    } else if (property.name === "END") {
      if (stack.length > 1) stack.pop();
    } else current.properties.push(property);
  }
  return root.children;
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) =>
    char.toLowerCase() === "n" ? "\n" : char,
  );
}

export function escapeText(value: string): string {
  return value.replace(/[\\;,]/g, (char) => `\\${char}`).replace(/\r?\n/g, "\\n");
}

/** Common Windows zone names Outlook writes, as IANA zones. */
const WINDOWS_ZONES: Record<string, string> = {
  UTC: "UTC",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Turkey Standard Time": "Europe/Istanbul",
  "Russian Standard Time": "Europe/Moscow",
  "Arabian Standard Time": "Asia/Dubai",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "SA Pacific Standard Time": "America/Bogota",
  "E. South America Standard Time": "America/Sao_Paulo",
};

/** An IANA zone for a TZID, or null when it is not one this device knows. */
export function resolveZone(tzid: string | undefined): string | null {
  if (!tzid) return null;
  if (isTimeZone(tzid)) return tzid;
  const tail = /([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(tzid)?.[1];
  if (tail && isTimeZone(tail)) return tail;
  const windows = WINDOWS_ZONES[tzid.trim()];
  return windows && isTimeZone(windows) ? windows : null;
}

type Moment =
  { kind: "date"; date: LocalDate } | { kind: "time"; wall: LocalDateTime; zone: string | null };

function parseMoment(value: string, params: Record<string, string>): Moment | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (params.VALUE === "DATE" || !match[4]) return { kind: "date", date };
  const wall = `${date}T${match[4]}:${match[5]}`;
  return { kind: "time", wall, zone: match[7] ? "UTC" : resolveZone(params.TZID) };
}

/** A moment as wall time in a zone (null: the viewer's). */
function wallIn(moment: Moment, zone: string | null, viewerZone: string): LocalDateTime {
  if (moment.kind === "date") return `${moment.date}T00:00`;
  const from = moment.zone ?? viewerZone;
  const to = zone ?? viewerZone;
  return from === to ? moment.wall : toWall(toInstant(moment.wall, from), to);
}

/** An ISO 8601 duration ("P1DT2H", "-PT15M") in minutes. */
export function durationMinutes(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (!match || value.trim().replace(/^[+-]/, "") === "P") return null;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const total =
    Number(weeks ?? 0) * 10_080 +
    Number(days ?? 0) * 1440 +
    Number(hours ?? 0) * 60 +
    Number(minutes ?? 0) +
    Math.floor(Number(seconds ?? 0) / 60);
  return sign === "-" ? -total : total;
}

function reminderMinutes(alarm: Component, allDay: boolean, start: number): number | null {
  const trigger = alarm.properties.find((property) => property.name === "TRIGGER");
  if (!trigger) return null;
  let before: number | null;
  if (trigger.params.VALUE === "DATE-TIME") {
    const moment = parseMoment(trigger.value, trigger.params);
    if (!moment || moment.kind !== "time") return null;
    before = Math.round((start - toInstant(moment.wall, moment.zone ?? "UTC")) / 60_000);
  } else {
    if (trigger.params.RELATED === "END") return null;
    const offset = durationMinutes(trigger.value);
    before = offset === null ? null : -offset;
  }
  if (before === null) return null;
  // All-day reminders count from 09:00 on the day; the file counts from midnight.
  if (allDay) before += 9 * 60;
  return before >= 0 && before <= 40_320 ? before : null;
}

/** UNTIL as this app's wall-time form (the rule steps through wall times written as UTC). */
function untilToWall(
  rule: string,
  zone: string | null,
  allDay: boolean,
  viewerZone: string,
): string {
  return rule.replace(/UNTIL=(\d{8})(T\d{6}Z?)?/i, (whole, date: string, time?: string) => {
    if (!time) return `UNTIL=${date}T235959Z`;
    if (allDay || !time.endsWith("Z")) return `UNTIL=${date}${time.replace(/Z$/, "")}Z`;
    const wall = toWall(
      Date.parse(
        `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(1, 3)}:${time.slice(3, 5)}:${time.slice(5, 7)}Z`,
      ),
      zone ?? viewerZone,
    );
    return `UNTIL=${wall.replace(/[-:]/g, "")}00Z`;
  });
}

export interface Imported {
  name: string | null;
  events: CalendarEvent[];
  /** Events left out: cancelled, without a start, or past the limit. */
  skipped: number;
  /** Events whose time zone this device does not know (shown in the person's own). */
  unknownZones: number;
}

/** The events of an .ics file for a calendar of this app. */
export function parseIcs(
  text: string,
  { calendarId, viewerZone, now }: { calendarId: string; viewerZone: string; now: number },
): Imported {
  const calendars = parseComponents(text).filter((component) => component.name === "VCALENDAR");
  if (!calendars.length) throw new SyntaxError("Not an iCalendar file");
  const result: Imported = { name: null, events: [], skipped: 0, unknownZones: 0 };
  const overrides: Array<{ event: CalendarEvent; recurrenceId: Moment }> = [];
  for (const calendar of calendars) {
    result.name ??=
      calendar.properties.find((property) => property.name === "X-WR-CALNAME")?.value ?? null;
    for (const component of calendar.children) {
      if (component.name !== "VEVENT") continue;
      const get = (name: string) => component.properties.find((property) => property.name === name);
      if (
        get("STATUS")?.value.toUpperCase() === "CANCELLED" ||
        result.events.length >= MAX_IMPORTED
      ) {
        result.skipped += 1;
        continue;
      }
      const startProperty = get("DTSTART");
      const start = startProperty && parseMoment(startProperty.value, startProperty.params);
      if (!start) {
        result.skipped += 1;
        continue;
      }
      if (start.kind === "time" && startProperty.params.TZID && !start.zone)
        result.unknownZones += 1;
      const allDay = start.kind === "date";
      const zone = start.kind === "time" ? start.zone : null;
      const startValue = start.kind === "date" ? start.date : start.wall;
      const endProperty = get("DTEND");
      const end = endProperty && parseMoment(endProperty.value, endProperty.params);
      const duration = get("DURATION") && durationMinutes(get("DURATION")!.value);
      let endValue: string;
      if (allDay) {
        const endDate = end?.kind === "date" ? end.date : end ? dateOf(end.wall) : null;
        endValue =
          endDate && endDate > startValue
            ? endDate
            : addDays(startValue, duration ? Math.max(1, Math.round(duration / 1440)) : 1);
      } else {
        endValue = end
          ? wallIn(end, zone, viewerZone)
          : duration && duration > 0
            ? addMinutes(startValue, duration)
            : startValue;
        if (endValue < startValue) endValue = startValue;
      }
      const startInstant = toInstant(startValue, zone ?? viewerZone);
      const keyOf = (moment: Moment) =>
        allDay
          ? moment.kind === "date"
            ? moment.date
            : dateOf(moment.wall)
          : wallIn(moment, zone, viewerZone);
      let rrule = get("RRULE")?.value.replace(/\s/g, "") ?? null;
      if (rrule) {
        try {
          RRule.parseString(rrule);
          rrule = untilToWall(rrule, zone, allDay, viewerZone);
        } catch {
          rrule = null;
        }
      }
      const exdates = component.properties
        .filter((property) => property.name === "EXDATE")
        .flatMap((property) =>
          property.value.split(",").map((value) => parseMoment(value, property.params)),
        )
        .filter((moment): moment is Moment => moment !== null)
        .map(keyOf);
      const reminders = [
        ...new Set(
          component.children
            .filter((child) => child.name === "VALARM")
            .map((alarm) => reminderMinutes(alarm, allDay, startInstant))
            .filter((minutes): minutes is number => minutes !== null),
        ),
      ]
        .sort((a, b) => a - b)
        .slice(0, MAX_REMINDERS);
      const event: CalendarEvent = {
        id: newId(),
        uid: (get("UID")?.value || newUid()).slice(0, 255),
        calendarId,
        title: unescapeText(get("SUMMARY")?.value ?? "").slice(0, MAX_TITLE),
        allDay,
        start: startValue,
        end: endValue,
        timeZone: allDay ? null : zone,
        location: unescapeText(get("LOCATION")?.value ?? "").slice(0, MAX_TITLE),
        notes: unescapeText(get("DESCRIPTION")?.value ?? "").slice(0, MAX_TEXT),
        rrule,
        exdates: [...new Set(exdates)],
        reminders,
        createdAt: now,
        updatedAt: now,
      };
      const recurrenceIdProperty = get("RECURRENCE-ID");
      const recurrenceId =
        recurrenceIdProperty &&
        parseMoment(recurrenceIdProperty.value, recurrenceIdProperty.params);
      if (recurrenceId) overrides.push({ event: { ...event, rrule: null }, recurrenceId });
      else result.events.push(event);
    }
  }
  // A changed occurrence: left out of its series, and added on its own.
  for (const { event, recurrenceId } of overrides) {
    const master = result.events.find(
      (candidate) => candidate.uid === event.uid && candidate.rrule,
    );
    if (master) {
      const key = master.allDay
        ? recurrenceId.kind === "date"
          ? recurrenceId.date
          : dateOf(recurrenceId.wall)
        : wallIn(recurrenceId, master.timeZone, viewerZone);
      if (!master.exdates.includes(key)) master.exdates.push(key);
      result.events.push({ ...event, uid: `${event.uid}-${key.replace(/\D/g, "")}` });
    } else result.events.push(event);
  }
  return result;
}

const compact = (value: string) => value.replace(/[-:]/g, "");

function moment(name: string, value: string, allDay: boolean, zone: string | null): string {
  if (allDay) return `${name};VALUE=DATE:${compact(value)}`;
  const time = `${compact(value)}00`;
  if (zone === "UTC") return `${name}:${time}Z`;
  return zone ? `${name};TZID=${zone}:${time}` : `${name}:${time}`;
}

/** UNTIL as RFC 5545 wants it: a date for all-day events, UTC for zoned ones. */
function untilForExport(rule: string, event: CalendarEvent): string {
  return rule.replace(/UNTIL=(\d{8})T(\d{6})Z?/i, (whole, date: string, time: string) => {
    if (event.allDay) return `UNTIL=${date}`;
    const wall = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}`;
    if (!event.timeZone) return `UNTIL=${date}T${time}`;
    const instant = new Date(toInstant(wall, event.timeZone) + Number(time.slice(4, 6)) * 1000);
    return `UNTIL=${instant
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "")}`;
  });
}

const stamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** Folds a content line at 75 bytes, never inside a character. */
export function fold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function toIcs(events: readonly CalendarEvent[], name: string, now: number): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//EveryOS//Calendar 1.0//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
  ];
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${stamp(now)}`,
      ...(event.createdAt ? [`CREATED:${stamp(event.createdAt)}`] : []),
      ...(event.updatedAt ? [`LAST-MODIFIED:${stamp(event.updatedAt)}`] : []),
      moment("DTSTART", event.start, event.allDay, event.timeZone),
      moment("DTEND", event.end, event.allDay, event.timeZone),
      `SUMMARY:${escapeText(event.title)}`,
    );
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.notes) lines.push(`DESCRIPTION:${escapeText(event.notes)}`);
    if (event.rrule) {
      lines.push(`RRULE:${untilForExport(event.rrule, event)}`);
      if (event.exdates.length)
        lines.push(
          moment("EXDATE", event.exdates[0]!, event.allDay, event.timeZone).replace(
            /:[^:]*$/,
            `:${event.exdates.map((date) => (event.allDay ? compact(date) : `${compact(date)}00${event.timeZone === "UTC" ? "Z" : ""}`)).join(",")}`,
          ),
        );
    }
    for (const minutes of event.reminders) {
      // All-day reminders count from 09:00 on the day; the file counts from midnight.
      const offset = event.allDay ? minutes - 9 * 60 : minutes;
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeText(event.title || "Reminder")}`,
        `TRIGGER:${offset > 0 ? "-" : ""}P${durationText(Math.abs(offset))}`,
        "END:VALARM",
      );
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

function durationText(minutes: number): string {
  if (minutes === 0) return "T0M";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}W`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return `${days ? `${days}D` : ""}${hours || rest ? "T" : ""}${hours ? `${hours}H` : ""}${rest ? `${rest}M` : ""}`;
}
