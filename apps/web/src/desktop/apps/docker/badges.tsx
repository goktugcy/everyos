import type { ContainerState, DockerOwnership, HealthState } from "@everyos/shared";
import { ApiRequestError } from "../../../lib/api.ts";
import type { TFunction } from "i18next";
import {
  CircleCheck,
  CircleDashed,
  CircleStop,
  CircleX,
  HeartPulse,
  Loader2,
  PauseCircle,
  ShieldCheck,
  Share2,
  Unplug,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";

const pill =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold";

/** Container state with icon and label (never color alone). */
export function StateBadge({ state }: { state: ContainerState }) {
  const { t } = useTranslation();
  const Icon =
    state === "running"
      ? CircleCheck
      : state === "paused"
        ? PauseCircle
        : state === "restarting" || state === "removing"
          ? Loader2
          : state === "dead"
            ? CircleX
            : state === "exited"
              ? CircleStop
              : CircleDashed;
  return (
    <span
      className={cn(
        pill,
        state === "running" && "bg-success/15 text-success",
        state === "dead" && "bg-danger/15 text-danger",
        (state === "restarting" || state === "paused") && "bg-warning/15 text-warning",
        !["running", "dead", "restarting", "paused"].includes(state) && "bg-hover/8 text-fg-muted",
      )}
    >
      <Icon
        className={cn(
          "size-3.5",
          (state === "restarting" || state === "removing") && "animate-spin",
        )}
        aria-hidden
      />
      {t(`docker.states.${state}`)}
    </span>
  );
}

export function HealthBadge({ health }: { health: HealthState }) {
  const { t } = useTranslation();
  if (health === "none") return null;
  return (
    <span
      className={cn(
        pill,
        health === "healthy" && "bg-success/15 text-success",
        health === "unhealthy" && "bg-danger/15 text-danger",
        health === "starting" && "bg-warning/15 text-warning",
      )}
    >
      <HeartPulse className="size-3.5" aria-hidden />
      {t(`docker.health.${health}`)}
    </span>
  );
}

export function OwnershipBadge({ ownership }: { ownership: DockerOwnership }) {
  const { t } = useTranslation();
  const Icon = ownership === "external" ? Unplug : ownership === "imported" ? Share2 : ShieldCheck;
  return (
    <span
      className={cn(
        pill,
        "font-medium",
        ownership === "external"
          ? "bg-hover/8 text-fg-muted"
          : "bg-[rgb(var(--everyos-accent)/0.18)] text-fg",
      )}
      title={t(`docker.ownershipHelp.${ownership}`)}
    >
      <Icon className="size-3.5" aria-hidden />
      {t(`docker.ownership.${ownership}`)}
    </span>
  );
}

/** Explains a refused Docker action in the user's language. */
export function dockerErrorMessage(t: TFunction, error: unknown): string {
  if (error instanceof ApiRequestError) {
    const reason = (error.details as { reason?: string } | undefined)?.reason ?? "";
    if (error.code === "AGENT_OPERATION_DENIED" && reason.startsWith("DEVELOPMENT_MODE"))
      return t("docker.developmentHint");
    if (error.code === "AGENT_OPERATION_DENIED" && reason.startsWith("PROTECTED_CONTAINER"))
      return t("docker.protectedHelp");
    // Plain conflicts mean "still in use"; others carry details and are handled by their view.
    if (error.code === "CONFLICT" && error.details === undefined) return t("docker.inUse");
  }
  return errorMessage(t, error);
}

export function shortId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}
