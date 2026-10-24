/*
 * The Pomodoro timer as pure state transitions. Time is never counted in ticks (an app's frame is
 * throttled in the background): a running phase stores when it ends, and everything is computed
 * from the clock. A phase that ended while nobody watched completes on the next look, and with
 * auto-start the following phases are chained from the previous end, as if someone had watched.
 */

export type Phase = "focus" | "short" | "long";
export type Status = "idle" | "running" | "paused";

export interface TimerSettings {
  focusMinutes: number;
  shortMinutes: number;
  longMinutes: number;
  /** A long break after this many focus sessions. */
  longEvery: number;
  autoStartBreaks: boolean;
  autoStartFocus: boolean;
  notify: boolean;
}

export const DEFAULT_SETTINGS: TimerSettings = {
  focusMinutes: 25,
  shortMinutes: 5,
  longMinutes: 15,
  longEvery: 4,
  autoStartBreaks: false,
  autoStartFocus: false,
  notify: true,
};

export const LIMITS = {
  minutes: { min: 1, max: 180 },
  longEvery: { min: 2, max: 12 },
};

export interface TimerState {
  phase: Phase;
  status: Status;
  /** When the running phase ends. */
  endsAt: number | null;
  /** Time left while paused or idle. */
  remainingMs: number;
  /** The whole length of the current phase. */
  phaseMs: number;
  /** Focus sessions completed since the last long break. */
  cycle: number;
  /** When the current focus session first started (for the history). */
  startedAt: number | null;
  /** What the person works on (optional). */
  label: string;
  /** Increases with every change, so instances adopt the newest state. */
  rev: number;
}

export interface Session {
  id: string;
  start: number;
  end: number;
  /** Focused minutes (to one decimal). */
  minutes: number;
  label: string;
  /** False when the session was stopped early (skipped or reset). */
  completed: boolean;
}

export interface Completion {
  phase: Phase;
  endedAt: number;
  next: Phase;
  session: Session | null;
}

export function durationMs(phase: Phase, settings: TimerSettings): number {
  const minutes =
    phase === "focus"
      ? settings.focusMinutes
      : phase === "short"
        ? settings.shortMinutes
        : settings.longMinutes;
  return Math.round(minutes * 60_000);
}

export function initialState(settings: TimerSettings): TimerState {
  return {
    phase: "focus",
    status: "idle",
    endsAt: null,
    remainingMs: durationMs("focus", settings),
    phaseMs: durationMs("focus", settings),
    cycle: 0,
    startedAt: null,
    label: "",
    rev: 0,
  };
}

export function remainingMs(state: TimerState, now: number): number {
  return state.status === "running" && state.endsAt !== null
    ? Math.max(0, state.endsAt - now)
    : state.remainingMs;
}

const bump = (state: TimerState, patch: Partial<TimerState>): TimerState => ({
  ...state,
  ...patch,
  rev: state.rev + 1,
});

export function start(state: TimerState, now: number): TimerState {
  if (state.status === "running") return state;
  return bump(state, {
    status: "running",
    endsAt: now + state.remainingMs,
    startedAt: state.phase === "focus" ? (state.startedAt ?? now) : null,
  });
}

export function pause(state: TimerState, now: number): TimerState {
  if (state.status !== "running") return state;
  return bump(state, { status: "paused", remainingMs: remainingMs(state, now), endsAt: null });
}

/** A focus session stopped early: recorded when at least a minute was focused. */
function stoppedSession(state: TimerState, now: number): Session | null {
  if (state.phase !== "focus" || state.startedAt === null || state.status === "idle") return null;
  const focused = state.phaseMs - remainingMs(state, now);
  if (focused < 60_000) return null;
  return {
    id: `focus:${state.startedAt}`,
    start: state.startedAt,
    end: now,
    minutes: Math.round(focused / 6_000) / 10,
    label: state.label,
    completed: false,
  };
}

function nextPhase(phase: Phase, cycle: number, settings: TimerSettings): Phase {
  if (phase !== "focus") return "focus";
  return cycle % settings.longEvery === 0 ? "long" : "short";
}

function enter(
  state: TimerState,
  phase: Phase,
  cycle: number,
  settings: TimerSettings,
  startAt: number | null,
): TimerState {
  const autoStart =
    startAt !== null && (phase === "focus" ? settings.autoStartFocus : settings.autoStartBreaks);
  const duration = durationMs(phase, settings);
  return bump(state, {
    phase,
    cycle: phase === "long" ? 0 : cycle,
    status: autoStart ? "running" : "idle",
    endsAt: autoStart ? startAt + duration : null,
    remainingMs: duration,
    phaseMs: duration,
    startedAt: autoStart && phase === "focus" ? startAt : null,
  });
}

/**
 * Completes the phases that ended by `now` (at most 50: more means days away). Returns the new
 * state and what completed, oldest first.
 */
export function advance(
  state: TimerState,
  settings: TimerSettings,
  now: number,
): { state: TimerState; completed: Completion[] } {
  const completed: Completion[] = [];
  let current = state;
  for (let i = 0; i < 50; i += 1) {
    if (current.status !== "running" || current.endsAt === null || now < current.endsAt) break;
    const endedAt = current.endsAt;
    const cycle = current.phase === "focus" ? current.cycle + 1 : current.cycle;
    const next = nextPhase(current.phase, cycle, settings);
    completed.push({
      phase: current.phase,
      endedAt,
      next,
      session:
        current.phase === "focus" && current.startedAt !== null
          ? {
              id: `focus:${current.startedAt}`,
              start: current.startedAt,
              end: endedAt,
              minutes: Math.round(current.phaseMs / 6_000) / 10,
              label: current.label,
              completed: true,
            }
          : null,
    });
    current = enter(current, next, cycle, settings, endedAt);
  }
  return { state: current, completed };
}

/** Ends the current phase now and moves on (a focus session stopped early is recorded as such). */
export function skip(
  state: TimerState,
  settings: TimerSettings,
  now: number,
): { state: TimerState; session: Session | null } {
  const session = stoppedSession(state, now);
  const cycle = state.phase === "focus" ? state.cycle + 1 : state.cycle;
  const next = nextPhase(state.phase, cycle, settings);
  return { state: enter(state, next, cycle, settings, null), session };
}

/** Back to the start of the current phase. */
export function reset(
  state: TimerState,
  settings: TimerSettings,
  now: number,
): { state: TimerState; session: Session | null } {
  const session = stoppedSession(state, now);
  const duration = durationMs(state.phase, settings);
  return {
    state: bump(state, {
      status: "idle",
      endsAt: null,
      remainingMs: duration,
      phaseMs: duration,
      startedAt: null,
    }),
    session,
  };
}

/** New durations apply to an idle phase at once; a started phase keeps its time. */
export function applySettings(state: TimerState, settings: TimerSettings): TimerState {
  if (state.status !== "idle") return state;
  const duration = durationMs(state.phase, settings);
  return duration === state.remainingMs
    ? state
    : bump(state, { remainingMs: duration, phaseMs: duration });
}

export function clampSettings(settings: TimerSettings): TimerSettings {
  const minutes = (value: number) =>
    Math.min(LIMITS.minutes.max, Math.max(LIMITS.minutes.min, Math.round(value) || 1));
  return {
    ...settings,
    focusMinutes: minutes(settings.focusMinutes),
    shortMinutes: minutes(settings.shortMinutes),
    longMinutes: minutes(settings.longMinutes),
    longEvery: Math.min(
      LIMITS.longEvery.max,
      Math.max(LIMITS.longEvery.min, Math.round(settings.longEvery) || 4),
    ),
  };
}

export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
