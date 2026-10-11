import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

const styles = {
  info: { icon: Info, className: "border-accent/30 bg-accent/10 text-fg" },
  success: { icon: CheckCircle2, className: "border-success/30 bg-success/10 text-fg" },
  warning: { icon: AlertTriangle, className: "border-warning/35 bg-warning/10 text-fg" },
  danger: { icon: XCircle, className: "border-danger/40 bg-danger/12 text-fg" },
} as const;

export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: keyof typeof styles;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, className: toneClass } = styles[tone];
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-everyos-md border px-3.5 py-3 text-sm",
        toneClass,
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0 opacity-90" aria-hidden />
      <div className="flex min-w-0 flex-col gap-0.5 leading-relaxed">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="text-fg-muted">{children}</div> : null}
      </div>
    </div>
  );
}
