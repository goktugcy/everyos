import type { HomeAssistantEntity, WidgetSize } from "@everyos/shared";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.tsx";
import { desktop } from "../../desktop/state/controller.ts";
import { Row, Rows } from "../../desktop/widgets/templates.tsx";
import { Placeholder } from "../../desktop/widgets/renderers/gate.tsx";
import { EntityControls } from "./entity-controls.tsx";
import { BrandIcon, DeviceSymbol } from "./device-symbol.tsx";
import { entityValue } from "./labels.ts";

export function WidgetEntities({
  entities,
  integrationId,
  controls,
  size,
}: {
  entities: HomeAssistantEntity[];
  integrationId: string;
  controls: boolean;
  size: WidgetSize;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const limit = controls
    ? size === "small"
      ? 2
      : size === "large"
        ? 6
        : 4
    : size === "small"
      ? 5
      : size === "large"
        ? 16
        : 8;
  const pages = Math.max(1, Math.ceil(entities.length / limit));
  const current = Math.min(page, pages - 1);
  const visible = entities.slice(current * limit, (current + 1) * limit);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="min-h-0 flex-1 overflow-auto">
        {entities.length === 0 ? (
          <Placeholder compact={false}>{t("widgets.text.entitiesNotShared")}</Placeholder>
        ) : controls ? (
          <ul className="flex flex-col gap-3">
            {visible.map((entity) => (
              <li
                key={entity.entityId}
                data-entity-id={entity.entityId}
                className="flex flex-col gap-1.5 rounded-everyos-sm bg-hover/5 p-2"
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span
                    className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium"
                    title={[entity.entityId, entity.device?.manufacturer, entity.device?.model]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    <DeviceSymbol entity={entity} className="size-4 shrink-0 text-accent" />
                    <BrandIcon
                      key={entity.device?.brand}
                      integrationId={integrationId}
                      entity={entity}
                    />
                    {entity.name ?? entity.entityId}
                  </span>
                  <span className="shrink-0 text-xs text-fg-muted">{entityValue(t, entity)}</span>
                </div>
                <EntityControls integrationId={integrationId} entity={entity} compact />
              </li>
            ))}
          </ul>
        ) : (
          <Rows>
            {visible.map((entity) => (
              <Row
                key={entity.entityId}
                label={entity.name ?? entity.entityId}
                value={entityValue(t, entity)}
                title={entity.entityId}
              />
            ))}
          </Rows>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-t border-line pt-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => desktop.openApp("everyos.homeassistant", { appState: { integrationId } })}
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {t("homeAssistant.openPanel")}
        </Button>
        {pages > 1 ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={current === 0}
              aria-label={t("homeAssistant.previous")}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft className="size-3.5" aria-hidden />
            </Button>
            <span className="text-xs tabular-nums">
              {t("homeAssistant.page", { page: current + 1, pages })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={current === pages - 1}
              aria-label={t("homeAssistant.next")}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
