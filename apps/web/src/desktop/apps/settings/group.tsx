import type { ReactNode } from "react";
import { cn } from "../../../lib/cn.ts";

/** A titled block of settings. */
export function SettingsGroup({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-4", className)} aria-label={title}>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? (
          <p className="text-xs leading-relaxed text-fg-muted">{description}</p>
        ) : null}
      </div>
      <div className="glass-inset flex flex-col gap-4 rounded-otk-lg p-4">{children}</div>
    </section>
  );
}

/** Label + control on one line. */
export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm">{label}</span>
        {hint ? <span className="text-xs text-fg-muted">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}
