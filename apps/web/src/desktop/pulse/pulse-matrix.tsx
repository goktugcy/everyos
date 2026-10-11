import { useId, useMemo } from "react";
import { arrowDots, graphColumns, MATRIX_COLS, MATRIX_ROWS } from "./pulse-lib.ts";

const PITCH = 5.4;
const RADIUS = 1.45;
const WIDTH = MATRIX_COLS * PITCH;
const HEIGHT = MATRIX_ROWS * PITCH;

export type MatrixMode =
  /** Live CPU history (percent, oldest first). */
  | { kind: "graph"; values: readonly number[] }
  /** No data to show: a slow shimmer. */
  | { kind: "idle" }
  /** Files are being dragged: arrows pointing into the shelf. */
  | { kind: "drop" };

const cells = Array.from({ length: MATRIX_COLS * MATRIX_ROWS }, (_, index) => ({
  col: index % MATRIX_COLS,
  row: Math.floor(index / MATRIX_COLS),
}));

/**
 * The pulse's dot matrix (34 × 5 dots). It draws the server's CPU history as
 * lit columns, shimmers when there is nothing to show, turns into arrows while
 * files are dragged, and a band of accent light sweeps across while a job runs.
 */
export function PulseMatrix({ mode, busy }: { mode: MatrixMode; busy: boolean }) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const heights = useMemo(() => (mode.kind === "graph" ? graphColumns(mode.values) : null), [mode]);
  const arrows = useMemo(() => (mode.kind === "drop" ? arrowDots() : null), [mode.kind]);

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      aria-hidden
      className="block overflow-visible"
      data-mode={mode.kind}
    >
      <defs>
        <pattern id={`${id}-dots`} width={PITCH} height={PITCH} patternUnits="userSpaceOnUse">
          <circle cx={PITCH / 2} cy={PITCH / 2} r={RADIUS + 0.2} fill="white" />
        </pattern>
        <mask id={`${id}-mask`}>
          <rect width={WIDTH} height={HEIGHT} fill={`url(#${id}-dots)`} />
        </mask>
        <linearGradient id={`${id}-band`}>
          <stop offset="0" stopColor="rgb(var(--otk-accent))" stopOpacity="0" />
          <stop offset="0.5" stopColor="rgb(var(--otk-accent))" stopOpacity="1" />
          <stop offset="1" stopColor="rgb(var(--otk-accent))" stopOpacity="0" />
        </linearGradient>
      </defs>
      {cells.map(({ col, row }) => {
        const cx = col * PITCH + PITCH / 2;
        const cy = row * PITCH + PITCH / 2;
        const key = `${col}:${row}`;
        if (mode.kind === "drop") {
          const lit = arrows?.has(key) ?? false;
          return (
            <circle
              key={key}
              cx={cx}
              cy={cy}
              r={RADIUS}
              className={lit ? "otk-pulse-blink" : undefined}
              style={{
                fill: lit ? "rgb(var(--otk-accent))" : "rgb(var(--otk-text) / 0.2)",
                ...(lit ? { animationDelay: `${(col % 12) * 40}ms` } : {}),
              }}
            />
          );
        }
        if (mode.kind === "idle")
          return (
            <circle
              key={key}
              cx={cx}
              cy={cy}
              r={RADIUS}
              className="otk-pulse-shimmer"
              style={{
                fill: "rgb(var(--otk-text))",
                animationDelay: `${col * 90 + row * 140}ms`,
              }}
            />
          );
        // Graph: dots light up from the bottom; a heavy load tints the top dot.
        const height = heights?.[col] ?? 0;
        const lit = MATRIX_ROWS - row <= height;
        const peak = height === MATRIX_ROWS && row === 0;
        return (
          <circle
            key={key}
            cx={cx}
            cy={cy}
            r={RADIUS}
            style={{
              fill: peak
                ? "rgb(var(--otk-warning))"
                : lit
                  ? `rgb(var(--otk-text) / ${0.6 + (col / MATRIX_COLS) * 0.38})`
                  : "rgb(var(--otk-text) / 0.22)",
              transition: "fill 300ms ease",
            }}
          />
        );
      })}
      {busy ? (
        <g mask={`url(#${id}-mask)`}>
          <rect
            className="otk-pulse-sweep"
            width={WIDTH * 0.35}
            height={HEIGHT}
            fill={`url(#${id}-band)`}
          />
        </g>
      ) : null}
    </svg>
  );
}
