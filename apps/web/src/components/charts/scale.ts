/**
 * Clean axis ticks (0, 25, 50…) covering [0, max]. With `base` 1024 the steps
 * are clean in binary units (0, 4, 8, 12 GiB) so byte axes read naturally.
 */
export function niceTicks(max: number, count = 4, base: 10 | 1024 = 10): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  if (base === 1024) {
    const unit = 1024 ** Math.max(0, Math.floor(Math.log(max) / Math.log(1024)));
    return niceTicks(max / unit, count).map((tick) => tick * unit);
  }
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? rough;
  const ticks: number[] = [];
  for (let value = 0; value < max + step * 0.999; value += step)
    ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

/** Index of the time closest to `target` in an ascending array. */
export function nearestIndex(times: readonly number[], target: number): number {
  let low = 0;
  let high = times.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (times[mid]! < target) low = mid;
    else high = mid;
  }
  return Math.abs(times[high]! - target) < Math.abs(times[low]! - target) ? high : low;
}

/**
 * SVG path segments for a series with gaps: nulls (and jumps longer than
 * `maxGapMs`, i.e. missing samples) break the line instead of bridging it.
 */
export function linePaths(
  times: readonly number[],
  values: ReadonlyArray<number | null>,
  x: (time: number) => number,
  y: (value: number) => number,
  maxGapMs: number,
): Array<{ line: string; first: number; last: number }> {
  const segments: Array<{ parts: string[]; first: number; last: number }> = [];
  let open = false;
  for (let i = 0; i < times.length; i++) {
    const value = values[i];
    const time = times[i]!;
    if (value === null || value === undefined) {
      open = false;
      continue;
    }
    const current = segments.at(-1);
    if (open && current && time - times[current.last]! > maxGapMs) open = false;
    const point = `${x(time).toFixed(1)},${y(value).toFixed(1)}`;
    if (!open || !current) {
      segments.push({ parts: [`M${point}`], first: i, last: i });
      open = true;
    } else {
      current.parts.push(`L${point}`);
      current.last = i;
    }
  }
  return segments.map(({ parts, first, last }) => ({ line: parts.join(""), first, last }));
}
