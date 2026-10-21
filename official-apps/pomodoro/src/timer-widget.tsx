import { IconButton, useT } from "@everyos/app-ui";
import { Pause, Play, SkipForward } from "lucide-react";
import { useApp } from "@everyos/app-ui";
import { Ring } from "./ring.tsx";
import { formatClock, remainingMs } from "./timer.ts";
import { useTimer } from "./use-timer.ts";

/** The timer on the desktop or in the sidebar: the same state as the window. */
export function TimerWidget() {
  const app = useApp();
  const t = useT();
  const timer = useTimer("widget");
  const { state } = timer;
  if (!state) return <div className="pomo-widget" aria-busy="true" />;
  const left = remainingMs(state, timer.now);
  const running = state.status === "running";
  return (
    <div className="pomo-widget" data-phase={state.phase}>
      <button
        type="button"
        className="pomo-widget-open"
        aria-label={t("widget.open")}
        onClick={() => void app.window.open(null)}
      >
        <Ring
          progress={state.phaseMs ? 1 - left / state.phaseMs : 0}
          size={84}
          stroke={7}
          phase={state.phase}
        >
          <span className="pomo-widget-clock" role="timer">
            {formatClock(left)}
          </span>
        </Ring>
      </button>
      <div className="pomo-widget-side">
        <span className="pomo-widget-phase">{t(`phases.${state.phase}`)}</span>
        <span className="pomo-widget-status">
          {t(
            running
              ? `status.running.${state.phase}`
              : state.status === "paused"
                ? "status.paused"
                : "status.ready",
          )}
        </span>
        <div className="pomo-widget-actions">
          <IconButton
            variant="primary"
            label={
              running
                ? t("actions.pause")
                : state.status === "paused"
                  ? t("actions.resume")
                  : t("actions.start")
            }
            icon={running ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
            onClick={() => void timer.toggle()}
          />
          <IconButton
            label={t("actions.skip")}
            icon={<SkipForward size={16} aria-hidden />}
            onClick={() => void timer.skip()}
          />
        </div>
      </div>
    </div>
  );
}
