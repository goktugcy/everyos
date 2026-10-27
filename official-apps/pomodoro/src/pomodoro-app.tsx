import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  SettingRow,
  SettingsGroup,
  SettingsPanel,
  Switch,
  Tabs,
  TextField,
  Toolbar,
  ToolbarTitle,
  useApp,
  useAsync,
  useI18n,
  usePersistentState,
  useT,
} from "@everyos/app-ui";
import { History, Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Ring } from "./ring.tsx";
import { dailyTotals, dayKey, streak } from "./stats.ts";
import {
  clampSettings,
  formatClock,
  LIMITS,
  remainingMs,
  type Phase,
  type Session,
  type TimerSettings,
} from "./timer.ts";
import { useTimer, type Timer } from "./use-timer.ts";

type View = "timer" | "history" | "stats" | "settings";
const PHASES: Phase[] = ["focus", "short", "long"];

/** Space starts or pauses, R resets, S skips (not while typing). */
function useTimerKeys(timer: Timer) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.key === " " && !target?.closest("button, [role=tab], [role=switch]")) {
        event.preventDefault();
        void timer.toggle();
      } else if (event.key.toLowerCase() === "r") void timer.reset();
      else if (event.key.toLowerCase() === "s") void timer.skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [timer]);
}

export function PomodoroApp() {
  const app = useApp();
  const t = useT();
  const timer = useTimer("window");
  const [view, setView] = usePersistentState<View>("view", "timer");
  useTimerKeys(timer);

  const { state, now } = timer;
  const running = state?.status === "running";
  const left = state ? remainingMs(state, now) : 0;
  const title =
    running && state ? `${formatClock(left)} · ${t(`phases.${state.phase}`)}` : t("app.name");
  useEffect(() => {
    void app.window.setTitle(title);
  }, [app, title]);

  return (
    <div className="pomo">
      <Toolbar label={t("app.name")}>
        <ToolbarTitle>{t("app.name")}</ToolbarTitle>
        <Tabs<View>
          label={t("views.label")}
          value={view}
          onChange={setView}
          tabs={[
            { value: "timer", label: t("views.timer") },
            { value: "history", label: t("views.history") },
            { value: "stats", label: t("views.stats") },
            { value: "settings", label: t("ui.settings") },
          ]}
        />
      </Toolbar>
      <main className="pomo-main">
        {!state ? (
          timer.error ? (
            <ErrorState error={timer.error} />
          ) : (
            <LoadingState />
          )
        ) : view === "timer" ? (
          <TimerView timer={timer} />
        ) : view === "history" ? (
          <HistoryView />
        ) : view === "stats" ? (
          <StatsView />
        ) : (
          <SettingsView timer={timer} />
        )}
      </main>
    </div>
  );
}

function TimerView({ timer }: { timer: Timer }) {
  const t = useT();
  const state = timer.state!;
  // The label is saved once typing pauses, not on every key.
  const [label, setLabel] = useState(state.label);
  const { setLabel: saveLabel } = timer;
  useEffect(() => setLabel(state.label), [state.label]);
  useEffect(() => {
    if (label === state.label) return;
    const delay = setTimeout(() => void saveLabel(label), 500);
    return () => clearTimeout(delay);
  }, [label, state.label, saveLabel]);
  const left = remainingMs(state, timer.now);
  const progress = state.phaseMs ? 1 - left / state.phaseMs : 0;
  const running = state.status === "running";
  return (
    <div className="pomo-timer">
      <div className="pomo-phases" role="radiogroup" aria-label={t("phases.label")}>
        {PHASES.map((phase) => (
          <button
            key={phase}
            type="button"
            role="radio"
            aria-checked={state.phase === phase}
            className="pomo-phase"
            onClick={() => void timer.choose(phase)}
          >
            {t(`phases.${phase}`)}
          </button>
        ))}
      </div>
      <Ring progress={progress} size={240} stroke={12} phase={state.phase}>
        <span className="pomo-clock" role="timer" aria-live="off" aria-label={t("timer.left")}>
          {formatClock(left)}
        </span>
        <span className="pomo-status">
          {t(
            state.status === "running"
              ? `status.running.${state.phase}`
              : state.status === "paused"
                ? "status.paused"
                : "status.ready",
          )}
        </span>
      </Ring>
      <div
        className="pomo-cycle"
        aria-label={t("timer.cycle", { done: state.cycle, of: timer.settings.longEvery })}
      >
        {Array.from({ length: timer.settings.longEvery }, (_, index) => (
          <span key={index} className="pomo-dot" data-done={index < state.cycle || undefined} />
        ))}
      </div>
      <div className="pomo-controls">
        <Button
          variant="ghost"
          icon={<RotateCcw size={16} aria-hidden />}
          onClick={() => void timer.reset()}
          title={t("actions.resetHint")}
        >
          {t("actions.reset")}
        </Button>
        <Button
          variant="primary"
          className="pomo-start"
          icon={running ? <Pause size={18} aria-hidden /> : <Play size={18} aria-hidden />}
          onClick={() => void timer.toggle()}
        >
          {running
            ? t("actions.pause")
            : state.status === "paused"
              ? t("actions.resume")
              : t("actions.start")}
        </Button>
        <Button
          variant="ghost"
          icon={<SkipForward size={16} aria-hidden />}
          onClick={() => void timer.skip()}
          title={t("actions.skipHint")}
        >
          {t("actions.skip")}
        </Button>
      </div>
      {state.phase === "focus" ? (
        <div className="pomo-label">
          <TextField
            label={t("timer.label")}
            placeholder={t("timer.labelPlaceholder")}
            value={label}
            maxLength={120}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
      ) : null}
      {timer.error ? (
        <p className="pomo-error" role="alert">
          {t("errors.save")}
        </p>
      ) : null}
    </div>
  );
}

function useSessions() {
  const app = useApp();
  const result = useAsync(async () => (await app.storage.get<Session[]>("history")) ?? [], [app]);
  const { reload } = result;
  useEffect(() => {
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [reload]);
  return result;
}

function HistoryView() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const sessions = useSessions();
  const groups = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of sessions.data ?? []) {
      const key = dayKey(session.end);
      map.set(key, [...(map.get(key) ?? []), session]);
    }
    return [...map];
  }, [sessions.data]);
  if (!sessions.data)
    return sessions.error ? <ErrorState error={sessions.error} /> : <LoadingState />;
  if (!sessions.data.length)
    return (
      <EmptyState
        icon={<History size={30} aria-hidden />}
        title={t("history.empty")}
        text={t("history.emptyText")}
      />
    );
  const time = (value: number) => i18n.date(value, { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="pomo-history">
      <div className="pomo-history-head">
        <span>{t("history.count", { count: sessions.data.length })}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            if (
              await app.dialogs.confirm(t("history.clearTitle"), t("ui.deleteBody"), {
                confirm: t("history.clear"),
                destructive: true,
              })
            ) {
              await app.storage.set("history", []);
              sessions.reload();
            }
          }}
        >
          {t("history.clear")}
        </Button>
      </div>
      {groups.map(([day, list]) => (
        <section
          key={day}
          className="pomo-day"
          aria-label={i18n.date(list[0]!.end, { dateStyle: "full" })}
        >
          <h2>{i18n.date(list[0]!.end, { dateStyle: "full" })}</h2>
          <ul>
            {list.map((session) => (
              <li key={session.id}>
                <span className="pomo-day-time">
                  {time(session.start)} – {time(session.end)}
                </span>
                <span className="pomo-day-label">{session.label || t("history.unlabelled")}</span>
                <span className="pomo-day-minutes">
                  {t("history.minutes", { count: session.minutes })}
                </span>
                {session.completed ? null : <Badge tone="warning">{t("history.stopped")}</Badge>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function StatsView() {
  const t = useT();
  const i18n = useI18n();
  const sessions = useSessions();
  if (!sessions.data)
    return sessions.error ? <ErrorState error={sessions.error} /> : <LoadingState />;
  const now = Date.now();
  const days = dailyTotals(sessions.data, now, 7);
  const today = days.at(-1)!;
  const max = Math.max(60, ...days.map((day) => day.minutes));
  const week = days.reduce((sum, day) => sum + day.minutes, 0);
  return (
    <div className="pomo-stats">
      <div className="pomo-cards">
        <Stat
          label={t("stats.todayMinutes")}
          value={t("history.minutes", { count: today.minutes })}
        />
        <Stat label={t("stats.todaySessions")} value={i18n.number(today.sessions)} />
        <Stat label={t("stats.week")} value={t("history.minutes", { count: Math.round(week) })} />
        <Stat
          label={t("stats.streak")}
          value={t("stats.days", { count: streak(sessions.data, now) })}
        />
      </div>
      <figure className="pomo-chart">
        <figcaption>{t("stats.chart")}</figcaption>
        <svg viewBox="0 0 350 160" role="img" aria-label={t("stats.chart")}>
          {days.map((day, index) => {
            const height = (day.minutes / max) * 120;
            return (
              <g key={day.day} transform={`translate(${index * 50 + 10}, 0)`}>
                <title>
                  {i18n.date(day.start, { weekday: "long" })}:{" "}
                  {t("history.minutes", { count: day.minutes })}
                </title>
                <rect
                  className="pomo-bar"
                  x={4}
                  y={130 - height}
                  width={30}
                  height={Math.max(height, 1)}
                  rx={5}
                />
                <text x={19} y={150} textAnchor="middle" className="pomo-axis">
                  {i18n.date(day.start, { weekday: "short" })}
                </text>
              </g>
            );
          })}
        </svg>
      </figure>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="pomo-card">
      <span className="pomo-card-value">{value}</span>
      <span className="pomo-card-label">{label}</span>
    </div>
  );
}

function SettingsView({ timer }: { timer: Timer }) {
  const app = useApp();
  const t = useT();
  const { settings } = timer;
  const update = (patch: Partial<TimerSettings>) =>
    timer.setSettings((current) => clampSettings({ ...current, ...patch }));
  const number = (key: "focusMinutes" | "shortMinutes" | "longMinutes" | "longEvery") => {
    const limits = key === "longEvery" ? LIMITS.longEvery : LIMITS.minutes;
    return (
      <input
        type="number"
        className="eui-input pomo-number"
        aria-label={t(`settings.${key}`)}
        min={limits.min}
        max={limits.max}
        value={settings[key]}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (event.target.value !== "" && Number.isFinite(value)) update({ [key]: value });
        }}
      />
    );
  };
  const canNotify = app.permissions.has("notifications:send");
  return (
    <SettingsPanel>
      <SettingsGroup title={t("settings.durations")}>
        <SettingRow label={t("settings.focusMinutes")}>{number("focusMinutes")}</SettingRow>
        <SettingRow label={t("settings.shortMinutes")}>{number("shortMinutes")}</SettingRow>
        <SettingRow label={t("settings.longMinutes")}>{number("longMinutes")}</SettingRow>
        <SettingRow label={t("settings.longEvery")} description={t("settings.longEveryHint")}>
          {number("longEvery")}
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title={t("settings.flow")}>
        <SettingRow label={t("settings.autoStartBreaks")}>
          <Switch
            label={t("settings.autoStartBreaks")}
            checked={settings.autoStartBreaks}
            onChange={(autoStartBreaks) => update({ autoStartBreaks })}
          />
        </SettingRow>
        <SettingRow label={t("settings.autoStartFocus")}>
          <Switch
            label={t("settings.autoStartFocus")}
            checked={settings.autoStartFocus}
            onChange={(autoStartFocus) => update({ autoStartFocus })}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.notify")}
          description={canNotify ? t("settings.notifyHint") : t("settings.notifyDenied")}
        >
          <Switch
            label={t("settings.notify")}
            checked={settings.notify && canNotify}
            disabled={!canNotify}
            onChange={(notify) => update({ notify })}
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsPanel>
  );
}
