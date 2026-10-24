import { toInstant, toWall, timeOf, type LocalDate } from "./dates.ts";
import type { Occurrence } from "./recurrence.ts";

/** A timed occurrence placed in one day's column: minutes from midnight, and its lane. */
export interface Placed {
  occurrence: Occurrence;
  top: number;
  height: number;
  lane: number;
  lanes: number;
}

export const MINUTES_PER_DAY = 1440;
/** Short events still get room for their title. */
export const MIN_HEIGHT = 20;

/**
 * Lays out a day's timed occurrences side by side where they overlap: each group of overlapping
 * events shares the width, every event in the leftmost free lane.
 */
export function layoutDay(
  occurrences: readonly Occurrence[],
  day: LocalDate,
  zone: string,
): Placed[] {
  const dayStart = toInstant(day, zone);
  const dayEnd = toInstant(`${day}T23:59`, zone) + 60_000;
  const items = occurrences
    .filter(
      ({ event, start, end }) =>
        !event.allDay && start < dayEnd && (end > dayStart || (end === start && start >= dayStart)),
    )
    .map((occurrence) => {
      // Minutes on the clock (a day with a daylight-saving change still shows 24 hours).
      const top = occurrence.start <= dayStart ? 0 : minutesOf(toWall(occurrence.start, zone));
      const bottom =
        occurrence.end >= dayEnd ? MINUTES_PER_DAY : minutesOf(toWall(occurrence.end, zone));
      return { occurrence, top, height: Math.max(MIN_HEIGHT, bottom - top), end: bottom };
    })
    .sort((a, b) => a.top - b.top || b.end - a.end);
  const placed: Placed[] = [];
  let group: Array<(typeof items)[number] & { lane: number }> = [];
  let groupEnd = -1;
  const close = () => {
    const lanes = Math.max(1, ...group.map((item) => item.lane + 1));
    for (const item of group)
      placed.push({
        occurrence: item.occurrence,
        top: item.top,
        height: item.height,
        lane: item.lane,
        lanes,
      });
    group = [];
  };
  for (const item of items) {
    const visualEnd = item.top + item.height;
    if (group.length && item.top >= groupEnd) close();
    const busy = new Set(
      group.filter((other) => other.top + other.height > item.top).map((other) => other.lane),
    );
    let lane = 0;
    while (busy.has(lane)) lane += 1;
    group.push({ ...item, lane });
    groupEnd = Math.max(groupEnd, visualEnd);
  }
  if (group.length) close();
  return placed;
}

const minutesOf = (wall: string) => {
  const [hours, minutes] = timeOf(wall).split(":").map(Number) as [number, number];
  return hours * 60 + minutes;
};
