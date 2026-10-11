import type { WidgetInstance } from "@everyos/shared";
import { cellsOf, getWidget, missingConfig, widgetAvailability } from "@everyos/widget-sdk";
import { FlaskConical, Lock, MoreHorizontal, Settings2 } from "lucide-react";
import {
  Component,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { ContextMenuArea, MenuDropdown } from "../menus/menus.tsx";
import { widgetActions } from "./actions.ts";
import { widgetTitle } from "./labels.ts";
import { widgetMenu } from "./menu.tsx";
import { Placeholder } from "./renderers/gate.tsx";
import { WIDGET_RENDERERS } from "./renderers/index.ts";
import { widgetUi } from "./ui-store.ts";
import { SourceReporterContext, StateActions, WidgetInstanceContext } from "./instance.tsx";

/** Keeps one failing widget from taking down the desktop. */
class WidgetErrorBoundary extends Component<
  { fallback: (reset: () => void) => ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed
      ? this.props.fallback(() => this.setState({ failed: false }))
      : this.props.children;
  }
}

/** A widget's content: checks, then the built-in renderer inside an error boundary. */
export function WidgetBody({ instance, compact }: { instance: WidgetInstance; compact: boolean }) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const [attempt, setAttempt] = useState(0);
  const manifest = getWidget(instance.widgetId);
  const Renderer = WIDGET_RENDERERS[instance.widgetId];

  let content: ReactNode;
  if (!manifest || !Renderer) {
    content = (
      <Placeholder compact={compact}>
        {t("widgets.states.unknown")}
        {!compact ? (
          <button
            type="button"
            className="ml-2 text-danger underline"
            onClick={() => widgetActions.remove(instance.id)}
          >
            {t("widgets.menu.remove")}
          </button>
        ) : null}
      </Placeholder>
    );
  } else if (!widgetAvailability(manifest, { permissions, capabilities: null }).ok) {
    content = <Placeholder compact={compact}>{t("widgets.states.forbidden")}</Placeholder>;
  } else if (missingConfig(manifest, instance.config).length > 0) {
    content = compact ? (
      <button
        type="button"
        className="flex items-center gap-1 text-fg-muted hover:text-fg"
        onClick={() => widgetUi.configure(instance.id)}
      >
        <Settings2 className="size-3.5" aria-hidden />
        {t("widgets.states.needsSetupShort")}
      </button>
    ) : (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-2 text-center text-xs text-fg-muted">
        <span>{t("widgets.states.needsSetup")}</span>
        <StateActions />
      </div>
    );
  } else {
    content = <Renderer instance={instance} compact={compact} size={instance.size} />;
  }

  return (
    <WidgetInstanceContext.Provider value={instance}>
      <WidgetErrorBoundary
        key={attempt}
        fallback={() => (
          <Placeholder compact={compact}>
            {t("widgets.states.crashed")}
            {!compact ? (
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => setAttempt((n) => n + 1)}
              >
                {t("common.retry")}
              </button>
            ) : null}
          </Placeholder>
        )}
      >
        {content}
      </WidgetErrorBoundary>
    </WidgetInstanceContext.Provider>
  );
}

/** Glass card with a title and menu around a widget (desktop and sidebar). */
export function WidgetFrame({
  instance,
  className,
  style,
  onHeaderPointerDown,
  children,
}: {
  instance: WidgetInstance;
  className?: string;
  style?: CSSProperties;
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Extra controls (e.g. the resize handle). */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [simulated, setSimulated] = useState(false);
  // Small tiles keep their title readable: the simulated-data label becomes an icon.
  const narrow = cellsOf(instance).w <= 2;
  const title = getWidget(instance.widgetId)
    ? widgetTitle(t, instance.widgetId)
    : instance.widgetId;
  return (
    <ContextMenuArea entries={() => widgetMenu(t, instance)}>
      <section
        aria-label={title}
        data-testid="widget"
        data-widget={instance.widgetId}
        className={cn(
          "group/widget relative isolate flex flex-col overflow-hidden rounded-everyos-lg text-fg",
          className,
        )}
        style={style}
      >
        {/* Opacity applies to the glass only; text stays fully legible. */}
        <div
          aria-hidden
          className="glass absolute inset-0 -z-10 rounded-everyos-lg"
          style={{ opacity: instance.opacity }}
        />
        <header
          className={cn(
            "flex h-8 shrink-0 select-none items-center gap-1.5 pl-3 pr-1 text-xs font-semibold text-fg-muted",
            onHeaderPointerDown && !instance.locked && "cursor-grab active:cursor-grabbing",
          )}
          onPointerDown={onHeaderPointerDown}
        >
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {simulated ? (
            narrow ? (
              <span
                className="grid size-5 shrink-0 place-items-center rounded-full bg-warning/15 text-warning"
                title={t("widgets.states.simulated")}
              >
                <FlaskConical className="size-3" aria-hidden />
                <span className="sr-only">{t("widgets.states.simulated")}</span>
              </span>
            ) : (
              <span className="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-[0.65rem] font-semibold text-warning">
                {t("widgets.states.simulated")}
              </span>
            )
          ) : null}
          {instance.locked ? (
            <Lock className="size-3 shrink-0" aria-label={t("widgets.menu.lock")} />
          ) : null}
          <MenuDropdown
            align="end"
            label={t("widgets.menu.label", { name: title })}
            entries={widgetMenu(t, instance)}
            trigger={
              <button
                type="button"
                data-testid="widget-menu"
                className="grid size-6 place-items-center rounded-md text-fg-subtle opacity-70 outline-none hover:bg-hover/10 hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent group-hover/widget:opacity-100"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </button>
            }
          />
        </header>
        <div className="@container min-h-0 flex-1 overflow-hidden px-3 pb-3">
          <SourceReporterContext.Provider value={setSimulated}>
            <WidgetBody instance={instance} compact={false} />
          </SourceReporterContext.Provider>
        </div>
        {children}
      </section>
    </ContextMenuArea>
  );
}
