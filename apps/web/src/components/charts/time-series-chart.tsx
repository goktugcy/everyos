import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { cn } from "../../lib/cn.ts";
import { linePaths, nearestIndex, niceTicks } from "./scale.ts";

export interface ChartSeries {
  id: string;
  label: string;
  /** CSS color for marks only; text always uses text tokens. */
  color: string;
  values: ReadonlyArray<number | null>;
}

export interface TimeSeriesChartProps {
  /** Accessible name of the chart. */
  label: string;
  times: readonly number[];
  series: readonly ChartSeries[];
  /** Visible time window [start, end]. */
  domain: readonly [number, number];
  /** Fixed upper bound (e.g. 100 for percentages); otherwise derived from the data. */
  yMax?: number;
  /** 1024 for byte values, so ticks fall on whole KiB/MiB/GiB. */
  tickBase?: 10 | 1024;
  formatValue: (value: number) => string;
  formatTick?: (value: number) => string;
  formatTime: (time: number) => string;
  /** Longer gaps between samples break the line instead of bridging missing data. */
  maxGapMs: number;
  height?: number;
  /** Keeps the previous render visible (dimmed) while new data loads. */
  dimmed?: boolean;
}

const MARGIN = { top: 8, right: 10, bottom: 20, left: 56 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.floor(entry?.contentRect.width ?? 0)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Line/area chart for metric time series (SVG, no dependencies). Thin 2px
 * lines over a 10% wash, hairline grid, an end marker per series, and a
 * crosshair that snaps to the nearest sample and lists every series — by
 * pointer and by keyboard (arrow keys).
 */
export function TimeSeriesChart({
  label,
  times,
  series,
  domain,
  yMax,
  tickBase = 10,
  formatValue,
  formatTick = formatValue,
  formatTime,
  maxGapMs,
  height = 150,
  dimmed = false,
}: TimeSeriesChartProps) {
  const [containerRef, width] = useWidth<HTMLDivElement>();
  const [hovered, setActive] = useState<number | null>(null);
  // A shorter data window (e.g. a range change) invalidates the hovered index.
  const active = hovered !== null && hovered < times.length ? hovered : null;
  const [keyboard, setKeyboard] = useState(false);
  const describedBy = useId();

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const dataMax = Math.max(
    0,
    ...series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v))),
  );
  const candidates = niceTicks(yMax ?? (dataMax > 0 ? dataMax : 1), 4, tickBase);
  const top = yMax ?? candidates.at(-1) ?? 1;
  // A fixed maximum (e.g. installed memory) is the top edge; no tick may exceed it.
  const ticks = candidates.filter((tick) => tick <= top * 1.0001);
  const [start, end] = domain;
  const span = Math.max(1, end - start);
  const x = (time: number) => MARGIN.left + ((time - start) / span) * plotWidth;
  const y = (value: number) => MARGIN.top + plotHeight - (Math.min(value, top) / top) * plotHeight;
  const baseline = MARGIN.top + plotHeight;

  const pick = (clientX: number, element: Element) => {
    if (times.length === 0) return;
    const rect = element.getBoundingClientRect();
    const time = start + ((clientX - rect.left - MARGIN.left) / Math.max(1, plotWidth)) * span;
    setActive(nearestIndex(times, time));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (times.length === 0) return;
    const last = times.length - 1;
    const step = event.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = Math.max(0, (active ?? last) - step);
    else if (event.key === "ArrowRight") next = Math.min(last, (active ?? last) + step);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape") {
      setActive(null);
      return;
    }
    if (next !== null) {
      event.preventDefault();
      setKeyboard(true);
      setActive(next);
    }
  };

  const activeTime = active !== null ? times[active] : undefined;
  const readout =
    activeTime !== undefined
      ? `${formatTime(activeTime)}: ${series
          .map(
            (s) =>
              `${s.label} ${typeof s.values[active!] !== "number" ? "—" : formatValue(s.values[active!]!)}`,
          )
          .join(", ")}`
      : "";
  const tooltipLeft = activeTime !== undefined ? x(activeTime) : 0;
  const flip = tooltipLeft > width / 2;

  return (
    <div
      ref={containerRef}
      className={cn("relative select-none outline-none transition-opacity", dimmed && "opacity-50")}
      style={{ height }}
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onBlur={() => {
        setKeyboard(false);
        setActive(null);
      }}
    >
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          className="block touch-pan-y"
          aria-hidden
          onPointerMove={(event: PointerEvent<SVGSVGElement>) => {
            setKeyboard(false);
            pick(event.clientX, event.currentTarget);
          }}
          onPointerLeave={() => !keyboard && setActive(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="currentColor"
                className="text-fg-subtle"
                strokeOpacity={tick === 0 ? 0.35 : 0.14}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={MARGIN.left - 8}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                className="fill-fg-subtle text-[10px] tabular-nums"
              >
                {formatTick(tick)}
              </text>
            </g>
          ))}
          <text x={MARGIN.left} y={height - 4} className="fill-fg-subtle text-[10px] tabular-nums">
            {formatTime(start)}
          </text>
          <text
            x={width - MARGIN.right}
            y={height - 4}
            textAnchor="end"
            className="fill-fg-subtle text-[10px] tabular-nums"
          >
            {formatTime(end)}
          </text>

          {series.map((s) =>
            linePaths(times, s.values, x, y, maxGapMs).map((segment) => (
              <g key={`${s.id}-${segment.first}`}>
                <path
                  d={`${segment.line}L${x(times[segment.last]!).toFixed(1)},${baseline}L${x(times[segment.first]!).toFixed(1)},${baseline}Z`}
                  fill={s.color}
                  fillOpacity={0.1}
                />
                <path
                  d={segment.line}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            )),
          )}

          {activeTime === undefined
            ? series.map((s) => {
                let index = s.values.length - 1;
                while (index >= 0 && typeof s.values[index] !== "number") index--;
                if (index < 0 || times[index] === undefined) return null;
                return (
                  <circle
                    key={s.id}
                    cx={x(times[index]!)}
                    cy={y(s.values[index]!)}
                    r={4}
                    fill={s.color}
                    stroke="rgb(var(--otk-surface))"
                    strokeWidth={2}
                  />
                );
              })
            : null}

          {activeTime !== undefined ? (
            <g>
              <line
                x1={x(activeTime)}
                x2={x(activeTime)}
                y1={MARGIN.top}
                y2={baseline}
                stroke="currentColor"
                className="text-fg-muted"
                strokeOpacity={0.5}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              {series.map((s) => {
                const value = s.values[active!];
                return typeof value !== "number" ? null : (
                  <circle
                    key={s.id}
                    cx={x(activeTime)}
                    cy={y(value)}
                    r={4}
                    fill={s.color}
                    stroke="rgb(var(--otk-surface))"
                    strokeWidth={2}
                  />
                );
              })}
            </g>
          ) : null}
        </svg>
      ) : null}

      {activeTime !== undefined ? (
        <div
          className="glass-strong pointer-events-none absolute top-1 z-10 min-w-36 rounded-otk-sm px-3 py-2 text-xs shadow-lg"
          style={
            flip
              ? { right: Math.max(4, width - tooltipLeft + 12) }
              : { left: Math.min(tooltipLeft + 12, Math.max(4, width - 160)) }
          }
        >
          <div className="mb-1 tabular-nums text-fg-muted">{formatTime(activeTime)}</div>
          {series.map((s) => {
            const value = s.values[active!];
            return (
              <div key={s.id} className="flex items-center gap-2">
                <span
                  className="h-0.5 w-3 shrink-0 rounded-full"
                  style={{ background: s.color }}
                  aria-hidden
                />
                <span className="font-semibold tabular-nums text-fg">
                  {typeof value !== "number" ? "—" : formatValue(value)}
                </span>
                <span className="text-fg-muted">{s.label}</span>
              </div>
            );
          })}
        </div>
      ) : null}
      <span id={describedBy} className="sr-only" aria-live={keyboard ? "polite" : "off"}>
        {readout}
      </span>
    </div>
  );
}
