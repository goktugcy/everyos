import type { WidgetInstance } from "@everyos/shared";
import { createContext, useContext, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { widgetActions } from "./actions.ts";
import { widgetUi } from "./ui-store.ts";

/** The instance a widget body belongs to (state messages offer to configure or remove it). */
export const WidgetInstanceContext = createContext<WidgetInstance | null>(null);

export function useWidgetInstance(): WidgetInstance | null {
  return useContext(WidgetInstanceContext);
}

/** Lets the frame label widgets that show simulated (development) data. */
export const SourceReporterContext = createContext<((simulated: boolean) => void) | null>(null);

export function useReportSource(source: unknown): void {
  const report = useContext(SourceReporterContext);
  const simulated = source === "simulated";
  useEffect(() => {
    if (source !== undefined) report?.(simulated);
  }, [report, simulated, source]);
}

/** Buttons shown with a state message that the user can resolve. */
export function StateActions({ remove = false }: { remove?: boolean }) {
  const { t } = useTranslation();
  const instance = useWidgetInstance();
  if (!instance) return null;
  return (
    <span className="flex flex-wrap justify-center gap-1.5">
      <button
        type="button"
        className="rounded-everyos-sm bg-hover/10 px-2 py-1 text-xs font-medium text-fg hover:bg-hover/16"
        onClick={() => widgetUi.configure(instance.id)}
      >
        {t("widgets.menu.configure")}
      </button>
      {remove ? (
        <button
          type="button"
          className="rounded-everyos-sm px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10"
          onClick={() => widgetActions.remove(instance.id)}
        >
          {t("widgets.menu.remove")}
        </button>
      ) : null}
    </span>
  );
}
