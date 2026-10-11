import { AlertTriangle, CircleCheck, OctagonAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

/** A headline value (stat tile contract: label · value · optional detail). */
export function Value({
  label,
  value,
  detail,
  className,
}: {
  label?: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      {label ? <span className="truncate text-xs text-fg-muted">{label}</span> : null}
      <span className="truncate text-2xl font-semibold text-fg">{value}</span>
      {detail ? <span className="truncate text-xs text-fg-subtle">{detail}</span> : null}
    </div>
  );
}

/**
 * Decorative trend line in the series color with a 10% wash. The exact
 * values are always shown as text next to it (it never carries data alone).
 */
export function Sparkline({
  values,
  max,
  color = "var(--everyos-chart-1)",
  className,
}: {
  values: ReadonlyArray<number | null>;
  max?: number;
  color?: string;
  className?: string;
}) {
  const points = values
    .map((v, i) => [i, v] as const)
    .filter((p): p is readonly [number, number] => p[1] !== null);
  if (points.length < 2) return <div className={cn("h-10", className)} aria-hidden />;
  const top = Math.max(max ?? 0, ...points.map(([, v]) => v), 1);
  const width = 100;
  const height = 32;
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * width;
  const y = (v: number) => height - (Math.min(v, top) / top) * (height - 2) - 1;
  const line = points
    .map(([i, v], index) => `${index === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join("");
  const area = `${line}L${x(points.at(-1)![0]).toFixed(1)},${height}L${x(points[0]![0]).toFixed(1)},${height}Z`;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("h-10 w-full", className)}
      aria-hidden
    >
      <path d={area} fill={color} fillOpacity={0.1} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Bar({
  percent,
  warnAt = 80,
  dangerAt = 90,
}: {
  percent: number;
  warnAt?: number;
  dangerAt?: number;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-[rgb(var(--everyos-accent)/0.16)]"
      aria-hidden
    >
      <div
        className={cn(
          "h-full rounded-full",
          clamped >= dangerAt ? "bg-danger" : clamped >= warnAt ? "bg-warning" : "bg-accent",
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ul className={cn("flex min-h-0 flex-col gap-1 overflow-hidden text-xs", className)}>
      {children}
    </ul>
  );
}

export function Row({
  label,
  value,
  title,
}: {
  label: ReactNode;
  value?: ReactNode;
  title?: string;
}) {
  return (
    <li className="flex min-w-0 items-center justify-between gap-2" title={title}>
      <span className="min-w-0 truncate text-fg-muted">{label}</span>
      {value !== undefined ? (
        <span className="shrink-0 font-medium tabular-nums text-fg">{value}</span>
      ) : null}
    </li>
  );
}

/** Severity with an icon and a label, never color alone. */
export function Status({
  tone,
  children,
}: {
  tone: "ok" | "warning" | "critical" | "neutral";
  children: ReactNode;
}) {
  const Icon =
    tone === "ok"
      ? CircleCheck
      : tone === "critical"
        ? OctagonAlert
        : tone === "warning"
          ? AlertTriangle
          : null;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-xs font-semibold",
        tone === "ok" && "text-success",
        tone === "warning" && "text-warning",
        tone === "critical" && "text-danger",
        tone === "neutral" && "text-fg-muted",
      )}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}
