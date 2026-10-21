import type { EveryOSApp } from "@everyos/app-sdk";
import {
  CALENDAR_COLORS,
  newId,
  parseCalendar,
  parseEvent,
  type Calendar,
  type CalendarEvent,
} from "./model.ts";

/*
 * Events in the app's per-person storage, spread over shards (each storage value holds at most
 * 256 KiB). Every change re-reads its shard right before writing, one change at a time, so the
 * window and the widget do not undo each other.
 */

const SHARDS = 16;
const shardOf = (id: string) =>
  [...id].reduce((sum, char) => (sum + char.charCodeAt(0)) % SHARDS, 0);
const key = (shard: number) => `events/${shard}`;

export const MAX_CALENDARS = 50;

export class CalendarStore {
  readonly #app: EveryOSApp;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(app: EveryOSApp, now: () => number = () => Date.now()) {
    this.#app = app;
    this.#now = now;
  }

  #serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #shard(shard: number): Promise<CalendarEvent[]> {
    const stored = await this.#app.storage.get<unknown[]>(key(shard));
    return (Array.isArray(stored) ? stored : [])
      .map(parseEvent)
      .filter((event): event is CalendarEvent => event !== null);
  }

  async #locate(id: string): Promise<{ shard: number; events: CalendarEvent[] }> {
    const own = shardOf(id);
    const events = await this.#shard(own);
    if (events.some((event) => event.id === id)) return { shard: own, events };
    for (let shard = 0; shard < SHARDS; shard += 1) {
      if (shard === own) continue;
      const other = await this.#shard(shard);
      if (other.some((event) => event.id === id)) return { shard, events: other };
    }
    return { shard: own, events };
  }

  async events(): Promise<CalendarEvent[]> {
    const shards = await Promise.all(
      Array.from({ length: SHARDS }, (_, shard) => this.#shard(shard)),
    );
    return shards.flat();
  }

  /** The person's calendars; the first time, one named `defaultName`. */
  async calendars(defaultName: string): Promise<Calendar[]> {
    const stored = await this.#app.storage.get<unknown[]>("calendars");
    const calendars = (Array.isArray(stored) ? stored : [])
      .map(parseCalendar)
      .filter((calendar): calendar is Calendar => calendar !== null);
    if (calendars.length) return calendars;
    const first: Calendar = {
      id: "personal",
      name: defaultName,
      color: CALENDAR_COLORS[0],
      visible: true,
    };
    await this.saveCalendars([first]);
    return [first];
  }

  saveCalendars(calendars: Calendar[]): Promise<void> {
    return this.#serially(() =>
      this.#app.storage.set("calendars", calendars.slice(0, MAX_CALENDARS)),
    );
  }

  async addCalendar(name: string, existing: Calendar[]): Promise<Calendar> {
    const calendar: Calendar = {
      id: newId(),
      name: name.trim().slice(0, 80),
      color: CALENDAR_COLORS[existing.length % CALENDAR_COLORS.length]!,
      visible: true,
    };
    await this.saveCalendars([...existing, calendar]);
    return calendar;
  }

  /** Writes events (new or changed), grouped by shard. */
  put(...events: CalendarEvent[]): Promise<CalendarEvent[]> {
    return this.#serially(async () => {
      const saved: CalendarEvent[] = [];
      const byShard = new Map<number, CalendarEvent[]>();
      for (const event of events) {
        const { shard } = await this.#locate(event.id);
        byShard.set(shard, [...(byShard.get(shard) ?? []), event]);
      }
      for (const [shard, changed] of byShard) {
        const stored = await this.#shard(shard);
        for (const event of changed) {
          const updated = {
            ...event,
            updatedAt: this.#now(),
            createdAt: event.createdAt || this.#now(),
          };
          const index = stored.findIndex((entry) => entry.id === event.id);
          if (index === -1) stored.push(updated);
          else stored[index] = updated;
          saved.push(updated);
        }
        await this.#app.storage.set(key(shard), stored);
      }
      return saved;
    });
  }

  remove(...ids: string[]): Promise<void> {
    return this.#serially(async () => {
      const gone = new Set(ids);
      for (let shard = 0; shard < SHARDS; shard += 1) {
        const stored = await this.#shard(shard);
        const kept = stored.filter((event) => !gone.has(event.id));
        if (kept.length !== stored.length) await this.#app.storage.set(key(shard), kept);
      }
    });
  }

  /** Deletes a calendar and its events. */
  async removeCalendar(id: string, calendars: Calendar[]): Promise<void> {
    const events = await this.events();
    await this.remove(
      ...events.filter((event) => event.calendarId === id).map((event) => event.id),
    );
    await this.saveCalendars(calendars.filter((calendar) => calendar.id !== id));
  }
}
