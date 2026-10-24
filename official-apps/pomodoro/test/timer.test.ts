import { describe, expect, it } from "vitest";
import { dailyTotals, mergeSessions, streak } from "../src/stats.ts";
import {
  advance,
  applySettings,
  clampSettings,
  DEFAULT_SETTINGS,
  formatClock,
  initialState,
  pause,
  remainingMs,
  reset,
  skip,
  start,
  type Session,
  type TimerSettings,
} from "../src/timer.ts";

const MIN = 60_000;
const T0 = new Date(2026, 9, 21, 9, 0, 0).getTime();
const settings: TimerSettings = { ...DEFAULT_SETTINGS, longEvery: 2 };

describe("the timer", () => {
  it("counts down from the clock, pauses and resumes exactly", () => {
    let state = start(initialState(settings), T0);
    expect(state.endsAt).toBe(T0 + 25 * MIN);
    expect(remainingMs(state, T0 + 10 * MIN)).toBe(15 * MIN);
    state = pause(state, T0 + 10 * MIN);
    expect(state.status).toBe("paused");
    // Time passing while paused changes nothing.
    expect(remainingMs(state, T0 + 60 * MIN)).toBe(15 * MIN);
    state = start(state, T0 + 60 * MIN);
    expect(state.endsAt).toBe(T0 + 75 * MIN);
    expect(state.startedAt).toBe(T0);
    expect(state.rev).toBe(3);
  });

  it("completes focus into short and long breaks at the right cadence", () => {
    let state = start(initialState(settings), T0);
    let result = advance(state, settings, T0 + 25 * MIN);
    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]).toMatchObject({
      phase: "focus",
      next: "short",
      session: { start: T0, end: T0 + 25 * MIN, minutes: 25, completed: true },
    });
    state = result.state;
    expect(state).toMatchObject({ phase: "short", status: "idle", cycle: 1, remainingMs: 5 * MIN });
    state = start(state, T0 + 30 * MIN);
    state = advance(state, settings, T0 + 35 * MIN).state;
    expect(state.phase).toBe("focus");
    state = start(state, T0 + 35 * MIN);
    result = advance(state, settings, T0 + 61 * MIN);
    expect(result.completed[0]!.next).toBe("long");
    expect(result.state).toMatchObject({ phase: "long", cycle: 0, remainingMs: 15 * MIN });
  });

  it("chains auto-started phases that ended while nobody watched", () => {
    const auto = { ...settings, autoStartBreaks: true, autoStartFocus: true };
    const state = start(initialState(auto), T0);
    // Focus 25 + short 5 + focus 25 = 55 min, then the long break is running.
    const { state: next, completed } = advance(state, auto, T0 + 60 * MIN);
    expect(completed.map((entry) => entry.phase)).toEqual(["focus", "short", "focus"]);
    expect(completed[2]!.session).toMatchObject({ start: T0 + 30 * MIN, end: T0 + 55 * MIN });
    expect(next).toMatchObject({ phase: "long", status: "running", endsAt: T0 + 70 * MIN });
    expect(remainingMs(next, T0 + 60 * MIN)).toBe(10 * MIN);
  });

  it("records focus stopped early, and skips without a session under a minute", () => {
    let state = start(initialState(settings), T0);
    const skipped = skip(state, settings, T0 + 12 * MIN);
    expect(skipped.session).toMatchObject({ minutes: 12, completed: false });
    expect(skipped.state).toMatchObject({ phase: "short", status: "idle", cycle: 1 });
    state = start(initialState(settings), T0);
    expect(reset(state, settings, T0 + 30_000).session).toBeNull();
    expect(reset(state, settings, T0 + 30_000).state).toMatchObject({
      status: "idle",
      remainingMs: 25 * MIN,
    });
  });

  it("applies new durations only to an idle phase and keeps settings in bounds", () => {
    const idle = initialState(settings);
    expect(applySettings(idle, { ...settings, focusMinutes: 50 }).remainingMs).toBe(50 * MIN);
    const running = start(idle, T0);
    expect(applySettings(running, { ...settings, focusMinutes: 50 })).toBe(running);
    expect(
      clampSettings({ ...settings, focusMinutes: 0, shortMinutes: 999, longEvery: 1 }),
    ).toMatchObject({
      focusMinutes: 1,
      shortMinutes: 180,
      longEvery: 2,
    });
  });

  it("formats the clock", () => {
    expect(formatClock(25 * MIN)).toBe("25:00");
    expect(formatClock(59_001)).toBe("01:00");
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(90 * MIN)).toBe("1:30:00");
  });
});

describe("statistics", () => {
  const session = (dayOffset: number, minutes: number, completed = true): Session => {
    const end = T0 + dayOffset * 86_400_000;
    return { id: `focus:${end}`, start: end - minutes * MIN, end, minutes, label: "", completed };
  };

  it("totals the last days and counts the streak", () => {
    const sessions = [
      session(0, 25),
      session(0, 10, false),
      session(-1, 25),
      session(-2, 25),
      session(-4, 25),
    ];
    const days = dailyTotals(sessions, T0, 7);
    expect(days).toHaveLength(7);
    expect(days.at(-1)).toMatchObject({ minutes: 35, sessions: 1 });
    expect(days.at(-2)).toMatchObject({ minutes: 25, sessions: 1 });
    expect(days.at(-4)).toMatchObject({ minutes: 0, sessions: 0 });
    expect(streak(sessions, T0)).toBe(3);
    // Nothing yet today: yesterday's streak still counts.
    expect(streak(sessions.slice(2), T0)).toBe(2);
    expect(streak([], T0)).toBe(0);
  });

  it("merges sessions by id, so two instances record a completion once", () => {
    const first = session(0, 25);
    expect(mergeSessions([first], [first, session(-1, 25)])).toHaveLength(2);
    expect(mergeSessions([], [session(-1, 25), first])[0]).toBe(first);
  });
});
