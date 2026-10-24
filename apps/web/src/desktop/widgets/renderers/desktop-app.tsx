import { parseDesktopAppWidgetId } from "@everyos/widget-sdk";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppFrame } from "../../desktop-apps/app-frame.tsx";
import { useDesktopApps } from "../../desktop-apps/store.ts";
import { Placeholder, type WidgetRenderProps } from "./gate.tsx";

/**
 * A desktop app's widget: the app's own document in the same sandboxed frame as its windows,
 * with only the capabilities the widget declares. It loads once it comes into view.
 */
export function DesktopAppWidget({ instance, compact }: WidgetRenderProps) {
  const { t } = useTranslation();
  const parsed = parseDesktopAppWidgetId(instance.widgetId);
  const app = useDesktopApps((state) =>
    state.apps.find((entry) => entry.appId === parsed?.appId && entry.state === "active"),
  );
  const widget = app?.widgets.find((entry) => entry.id === parsed?.widgetId);
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element || seen) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);

  if (!app || !widget)
    return <Placeholder compact={compact}>{t("widgets.states.unknown")}</Placeholder>;
  return (
    <div ref={box} className="relative h-full w-full" data-testid="desktop-app-widget">
      {seen ? (
        <AppFrame
          app={app}
          kind="widget"
          widgetId={widget.id}
          entry={widget.entry}
          host={null}
          className="relative h-full w-full overflow-hidden rounded-everyos-sm"
        />
      ) : null}
    </div>
  );
}
