import type { WidgetInstance, WidgetSize } from "@otuken/shared";
import { CircleSlash, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TopicState } from "../topics.ts";
import { StateActions, useReportSource } from "../instance.tsx";

/** States the user can resolve from the widget (choose another link, or remove it). */
const FIXABLE = new Set(["app-removed", "not-configured", "auth-failed"]);

export interface WidgetRenderProps {
  instance: WidgetInstance;
  /** The menu bar renders one compact line. */
  compact: boolean;
  size: WidgetSize;
}

/** Shown instead of data while it loads or when it is not available (never fabricated values). */
export function Placeholder({
  compact,
  children,
  busy,
}: {
  compact: boolean;
  children: ReactNode;
  busy?: boolean;
}) {
  if (compact) return <span className="text-fg-subtle">—</span>;
  return (
    <div className="flex h-full min-h-12 flex-col items-center justify-center gap-2 p-2 text-center text-xs text-fg-subtle">
      <span className="flex items-center gap-2">
        {busy ? (
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
        ) : (
          <CircleSlash className="size-4 shrink-0" aria-hidden />
        )}
      </span>
      <span className="flex flex-col items-center gap-2">{children}</span>
    </div>
  );
}

/** Renders `children` with the topic's data, or the loading/unavailable/error state. */
export function TopicGate<T>({
  state,
  compact,
  children,
}: {
  state: TopicState<T>;
  compact: boolean;
  children: (data: T) => ReactNode;
}) {
  const { t } = useTranslation();
  useReportSource(
    state.status === "ok" ? (state.data as { source?: unknown } | null)?.source : undefined,
  );
  switch (state.status) {
    case "loading":
      return (
        <Placeholder compact={compact} busy>
          {t("common.loading")}
        </Placeholder>
      );
    case "unavailable":
      return (
        <Placeholder compact={compact}>
          {t(`widgets.reasons.${state.reason}`)}
          {!compact && FIXABLE.has(state.reason) ? (
            <StateActions remove={state.reason === "app-removed"} />
          ) : null}
        </Placeholder>
      );
    case "error":
      return (
        <Placeholder compact={compact}>
          {state.code === "FORBIDDEN"
            ? t("widgets.states.forbidden")
            : state.code === "NOT_FOUND"
              ? t("widgets.states.integrationMissing")
              : t("widgets.states.error")}
          {!compact && state.code === "NOT_FOUND" ? <StateActions remove /> : null}
        </Placeholder>
      );
    case "ok":
      return <>{children(state.data)}</>;
  }
}
