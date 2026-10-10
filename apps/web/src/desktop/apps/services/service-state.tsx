import type { ServiceUnit } from "@otuken/shared";
import type { TFunction } from "i18next";
import { CircleCheck, CircleDashed, CircleX, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/cn.ts";

/** Active state with icon + label (never color alone). */
export function ServiceStateBadge({ unit }: { unit: Pick<ServiceUnit, "active" | "sub"> }) {
  const { t } = useTranslation();
  const known = [
    "active",
    "inactive",
    "failed",
    "activating",
    "deactivating",
    "reloading",
  ].includes(unit.active);
  const label = known ? t(`services.activeStates.${unit.active as "active"}`) : unit.active;
  const Icon =
    unit.active === "active"
      ? CircleCheck
      : unit.active === "failed"
        ? CircleX
        : unit.active.endsWith("ing")
          ? Loader2
          : CircleDashed;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
        unit.active === "active" && "bg-success/15 text-success",
        unit.active === "failed" && "bg-danger/15 text-danger",
        unit.active !== "active" && unit.active !== "failed" && "bg-hover/8 text-fg-muted",
      )}
      title={unit.sub}
    >
      <Icon className={cn("size-3.5", unit.active.endsWith("ing") && "animate-spin")} aria-hidden />
      {label}
    </span>
  );
}

const UNIT_FILE_STATES = [
  "enabled",
  "disabled",
  "static",
  "masked",
  "indirect",
  "generated",
  "alias",
] as const;

export function unitFileLabel(t: TFunction, state: string | null): string {
  if (!state) return "—";
  return (UNIT_FILE_STATES as readonly string[]).includes(state)
    ? t(`services.unitFileStates.${state as (typeof UNIT_FILE_STATES)[number]}`)
    : state;
}
