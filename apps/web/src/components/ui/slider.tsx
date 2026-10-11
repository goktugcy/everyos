import { Slider as SliderPrimitive } from "radix-ui";
import { useId } from "react";

/** Labelled range slider with a live value read-out. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = (v) => String(v),
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <label id={id} className="text-fg-muted">
          {label}
        </label>
        <span className="tabular-nums text-fg">{format(value)}</span>
      </div>
      <SliderPrimitive.Root
        aria-labelledby={id}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => next !== undefined && onChange(next)}
        className="relative flex h-5 w-full touch-none select-none items-center"
      >
        <SliderPrimitive.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-hover/15">
          <SliderPrimitive.Range className="absolute h-full rounded-full bg-[rgb(var(--everyos-accent))]" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-labelledby={id}
          className="block size-4 rounded-full border border-black/10 bg-white shadow outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      </SliderPrimitive.Root>
      {hint ? <p className="text-xs leading-relaxed text-fg-subtle">{hint}</p> : null}
    </div>
  );
}
