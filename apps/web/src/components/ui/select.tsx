import { ChevronDown } from "lucide-react";
import { useId } from "react";
import { cn } from "../../lib/cn.ts";

/** Native select (best keyboard, screen reader and mobile support) in glass styling. */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  hideLabel,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  className?: string;
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={id}
        className={cn("text-[0.8rem] font-medium text-fg-muted", hideLabel && "sr-only")}
      >
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
          className="glass-inset h-10 w-full appearance-none rounded-everyos-md pl-3 pr-9 text-sm text-fg outline-none focus-visible:border-accent/70 focus-visible:shadow-[0_0_0_3px_rgb(var(--everyos-accent)/0.25)] [&>option]:bg-[rgb(var(--everyos-surface))] [&>option]:text-fg"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
          aria-hidden
        />
      </div>
    </div>
  );
}
