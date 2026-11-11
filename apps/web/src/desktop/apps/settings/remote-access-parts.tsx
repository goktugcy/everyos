import { useId, type ReactNode } from "react";
import { Switch } from "radix-ui";
import { AlertTriangle, Circle, ShieldAlert, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  RemoteAccessConflict,
  RemoteAccessNode,
  RemoteAccessProviderId,
} from "@everyos/shared";
import { cn } from "../../../lib/cn.ts";

const stateKey = {
  connected: "connected",
  connecting: "connecting",
  disconnected: "disconnected",
  "needs-login": "needsLogin",
  unknown: "unknown",
} as const;
export function providerStateText(t: TFunction, node: RemoteAccessNode | undefined): string {
  return t(
    !node
      ? "remoteAccess.unknown"
      : !node.installed
        ? "remoteAccess.notInstalled"
        : `remoteAccess.state_${stateKey[node.state]}`,
  );
}

export function ProviderLogo({
  provider,
  className,
}: {
  provider: RemoteAccessProviderId;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "grid size-11 shrink-0 place-items-center rounded-everyos-md bg-white p-2.5 ring-1 ring-black/10",
        className,
      )}
      aria-hidden="true"
    >
      <img
        src={`/provider-logos/${provider}.svg`}
        alt=""
        width={28}
        height={28}
        className="size-full object-contain"
        data-testid={`provider-logo-${provider}`}
      />
    </span>
  );
}

export function ProviderState({
  node,
  compact = false,
}: {
  node: RemoteAccessNode | undefined;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const active = node?.state === "connected" && node.available;
  const pending = node?.state === "connecting";
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 text-xs font-medium",
        compact ? "text-fg-muted" : "rounded-full border px-2.5 py-1",
        !compact &&
          (active
            ? "border-success/25 bg-success/10 text-success"
            : pending
              ? "border-accent/25 bg-accent/10 text-accent"
              : "border-line bg-hover/5 text-fg-muted"),
      )}
    >
      <Circle
        className={cn(
          "size-1.5 shrink-0 fill-current",
          active ? "text-success" : pending ? "text-accent" : "text-fg-subtle",
        )}
        aria-hidden
      />
      <span>{providerStateText(t, node)}</span>
    </span>
  );
}

export function SummaryItem({
  icon: Icon,
  label,
  children,
  className,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-everyos-md border border-line bg-hover/3 px-3.5 py-3",
        className,
      )}
    >
      <dt className="mb-2 flex items-start gap-2 text-xs leading-relaxed text-fg-muted">
        <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {label}
      </dt>
      <dd className="break-words text-sm font-medium [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function PreferenceToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-h-16 items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="mt-1 text-xs leading-relaxed text-fg-muted">
          {hint}
        </p>
      </div>
      <Switch.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-describedby={`${id}-hint`}
        className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full bg-hover/20 outline-none transition-colors after:absolute after:-inset-x-1 after:-inset-y-2.5 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-40 data-[state=checked]:bg-accent"
      >
        <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-150 motion-reduce:transition-none data-[state=checked]:translate-x-[22px]" />
      </Switch.Root>
    </div>
  );
}

const warningKey = {
  "multiple-active": "multipleActive",
  dns: "dns",
  subnet: "subnet",
  "exit-node": "exitNode",
  "route-policy": "routePolicy",
  visibility: "visibility",
} as const;
export function ConnectionWarnings({ conflicts }: { conflicts: RemoteAccessConflict[] }) {
  const { t } = useTranslation();
  if (!conflicts.length) return null;
  const critical = conflicts.some((item) => item.severity === "critical");
  return (
    <section
      aria-label={t("remoteAccess.connectionChecks")}
      className={cn(
        "rounded-everyos-lg border p-4",
        critical ? "border-danger/30 bg-danger/5" : "border-warning/25 bg-warning/5",
      )}
    >
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <ShieldAlert
          className={cn("size-4", critical ? "text-danger" : "text-warning")}
          aria-hidden
        />
        {t("remoteAccess.connectionChecks")}
      </h3>
      <ul className="space-y-3">
        {conflicts.map((warning, index) => (
          <li
            key={`${warning.kind}-${index}`}
            role={warning.severity === "info" ? "status" : "alert"}
            className="flex items-start gap-2.5 text-xs leading-relaxed text-fg-muted"
          >
            <AlertTriangle
              className={cn(
                "mt-0.5 size-3.5 shrink-0",
                warning.severity === "critical"
                  ? "text-danger"
                  : warning.severity === "warning"
                    ? "text-warning"
                    : "text-fg-subtle",
              )}
              aria-hidden
            />
            <div className="min-w-0">
              <p>{t(`remoteAccess.warning_${warningKey[warning.kind]}`)}</p>
              {warning.routes.length ? (
                <p className="mt-1 break-all font-mono text-fg">{warning.routes.join(" · ")}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
