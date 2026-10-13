import type { HomeAssistantStates, IntegrationView } from "@everyos/shared";
import {
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Home,
  Pencil,
  Plus,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { EntityControls } from "../../../features/home-assistant/entity-controls.tsx";
import { BrandIcon, DeviceSymbol } from "../../../features/home-assistant/device-symbol.tsx";
import {
  deviceGroups,
  roomGroups,
  type DeviceGroup,
} from "../../../features/home-assistant/device-groups.ts";
import { domainLabel, entityValue } from "../../../features/home-assistant/labels.ts";
import { api } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatDateTime } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { useIntegrations } from "../../widgets/integrations.ts";
import { useTopic, type TopicState } from "../../widgets/topics.ts";
import { useAppStateField } from "../app-context.ts";
import { IntegrationDialog } from "../settings/widgets-section.tsx";
import { LoadingBlock, ResourceError } from "../system/parts.tsx";

const PAGE_SIZE = 24;

function DeviceCard({
  group,
  integrationId,
  canManage,
  onDetails,
}: {
  group: DeviceGroup;
  integrationId: string;
  canManage: boolean;
  onDetails: () => void;
}) {
  const { t } = useTranslation();
  const entity = group.primary;
  const unavailable = group.entities.every(
    (e) => e.state === "unavailable" || e.state === "unknown",
  );
  const active = ["on", "playing", "cleaning", "heat", "cool", "open"].includes(entity.state);
  const metrics = group.entities
    .filter(
      (e) => e !== entity && !e.category && e.actions.length === 0 && !e.controls?.length && e.unit,
    )
    .slice(0, 2);
  return (
    <li
      className={cn(
        "glass-inset flex min-w-0 flex-col overflow-hidden rounded-everyos-lg border transition-colors",
        active ? "border-accent/30" : "border-line",
      )}
      data-entity-id={entity.entityId}
      data-device-id={entity.device?.id}
    >
      <button
        type="button"
        onClick={onDetails}
        className="flex min-w-0 flex-1 flex-col gap-4 p-4 text-left outline-none hover:bg-hover/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        aria-label={t("homeAssistant.detailsFor", { name: group.name })}
      >
        <div className="flex w-full items-center justify-between gap-3">
          <span
            className={cn(
              "grid size-11 place-items-center rounded-everyos-lg",
              active ? "bg-accent/15 text-accent" : "bg-hover/8 text-fg-muted",
            )}
          >
            <DeviceSymbol entity={entity} />
          </span>
          <span className={cn("text-xs", unavailable ? "text-warning" : "text-fg-subtle")}>
            {entity.area ?? t("homeAssistant.noArea")}
          </span>
        </div>
        <div className="min-w-0 w-full">
          <h3 className="truncate text-sm font-semibold" title={group.name}>
            {group.name}
          </h3>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-subtle">
            <BrandIcon key={entity.device?.brand} integrationId={integrationId} entity={entity} />
            <span className="truncate">
              {[entity.device?.manufacturer, entity.device?.model].filter(Boolean).join(" · ") ||
                domainLabel(t, entity.entityId.split(".")[0]!)}
            </span>
          </p>
        </div>
        <p
          className={cn(
            "text-xl font-medium tracking-tight",
            unavailable && "text-warning text-sm",
          )}
          role="status"
        >
          {entityValue(t, entity)}
        </p>
        {metrics.length ? (
          <div className="flex w-full flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
            {metrics.map((metric) => (
              <span key={metric.entityId} title={metric.name ?? metric.entityId}>
                {entityValue(t, metric)}
              </span>
            ))}
          </div>
        ) : null}
      </button>
      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2">
        {canManage && entity.actions.includes("toggle") ? (
          <EntityControls integrationId={integrationId} entity={entity} compact quick />
        ) : (
          <span className="text-xs text-fg-subtle">
            {t(
              group.entities.some((e) => e.actions.length || e.controls?.length) && canManage
                ? "homeAssistant.controlCount"
                : "homeAssistant.readOnly",
              {
                count: group.entities.filter((e) => e.actions.length || e.controls?.length).length,
              },
            )}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={onDetails}>
          {t("homeAssistant.details")}
        </Button>
      </div>
    </li>
  );
}

function EntityPanel({
  integration,
  canManage,
}: {
  integration: IntegrationView;
  canManage: boolean;
}) {
  const { t, i18n } = useTranslation();
  const live = useTopic<HomeAssistantStates>(`data.integration.${integration.id}.states`);
  const [manual, setManual] = useState<TopicState<HomeAssistantStates> | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const abort = useRef<AbortController | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const state =
    manual?.status === "ok" &&
    (live.status === "loading" || (live.status === "ok" && manual.at > live.at))
      ? manual
      : live;
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("");
  const [area, setArea] = useState("");
  const [view, setView] = useState<"devices" | "entities">("devices");
  const [controlsOnly, setControlsOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = async () => {
    if (refreshing) return;
    const controller = new AbortController();
    abort.current = controller;
    setRefreshing(true);
    setError(null);
    try {
      const result = await api<TopicState<HomeAssistantStates>>(
        `/integrations/${integration.id}/states`,
        { signal: controller.signal },
      );
      if (result.status === "ok") setManual(result);
      else if (result.status === "unavailable")
        setError(new Error(t(`widgets.reasons.${result.reason}`)));
      else setError(new Error(t("widgets.states.error")));
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught);
    } finally {
      if (!controller.signal.aborted) setRefreshing(false);
    }
  };
  const entities = state.status === "ok" ? state.data.entities : [];
  const groups = deviceGroups(entities, view);
  const areas = [
    ...new Set(entities.map((e) => e.area).filter((v): v is string => v !== null)),
  ].sort();
  const domains = [...new Set(entities.map((e) => e.entityId.split(".")[0]!))].sort();
  const filtered = groups.filter(
    (group) =>
      (!domain || group.entities.some((e) => e.entityId.startsWith(`${domain}.`))) &&
      (!area || group.entities.some((e) => (area === "__none" ? !e.area : e.area === area))) &&
      (!controlsOnly ||
        group.entities.some((e) => e.actions.length > 0 || Boolean(e.controls?.length))) &&
      `${group.name} ${group.entities.map((e) => `${e.name ?? ""} ${e.entityId} ${e.device?.manufacturer ?? ""} ${e.device?.model ?? ""}`).join(" ")}`
        .toLocaleLowerCase(i18n.language)
        .includes(query.toLocaleLowerCase(i18n.language)),
  );
  const ordered = roomGroups(filtered).flatMap((room) => room.groups);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [area, domain, query, view, current]);
  const detail = groups.find((g) => g.id === selected);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="home-assistant-panel">
      <div className="flex shrink-0 flex-wrap items-end gap-3 px-5 py-3">
        <div className="min-w-40 flex-1">
          <Field
            label={t("homeAssistant.search")}
            hideLabel
            className="h-10"
            placeholder={t("homeAssistant.searchPlaceholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </div>
        <div className="w-40">
          <Select
            label={t("homeAssistant.view")}
            hideLabel
            value={view}
            options={[
              { value: "devices", label: t("homeAssistant.devices") },
              { value: "entities", label: t("homeAssistant.entities") },
            ]}
            onChange={(value) => {
              if (value === "devices" || value === "entities") setView(value);
              setPage(0);
              setSelected(null);
            }}
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          loading={refreshing}
          onClick={() => void refresh()}
          aria-label={t("common.refresh")}
          title={t("common.refresh")}
        >
          <RefreshCw className="size-4" aria-hidden />
        </Button>
        <details className="relative">
          <summary className="flex cursor-pointer items-center gap-2 rounded-everyos-sm px-3 py-2 text-sm text-fg-muted hover:bg-hover/8">
            <SlidersHorizontal className="size-4" aria-hidden />
            {t("homeAssistant.filters")}
          </summary>
          <div className="glass-strong absolute right-0 z-10 mt-2 flex w-64 flex-col gap-3 rounded-everyos-md border border-line p-4">
            <Select
              label={t("homeAssistant.domain")}
              value={domain}
              options={[
                { value: "", label: t("homeAssistant.allDomains") },
                ...domains.map((value) => ({ value, label: domainLabel(t, value) })),
              ]}
              onChange={(value) => {
                setDomain(value);
                setPage(0);
              }}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[rgb(var(--everyos-accent))]"
                checked={controlsOnly}
                onChange={(e) => {
                  setControlsOnly(e.target.checked);
                  setPage(0);
                }}
              />
              {t("homeAssistant.controlsOnly")}
            </label>
          </div>
        </details>
      </div>
      <div
        className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-5 pb-3"
        role="group"
        aria-label={t("homeAssistant.rooms")}
      >
        {[
          { value: "", label: t("homeAssistant.allRooms") },
          ...areas.map((value) => ({ value, label: value })),
          ...(entities.some((e) => !e.area)
            ? [{ value: "__none", label: t("homeAssistant.noArea") }]
            : []),
        ].map((room) => (
          <button
            key={room.value}
            type="button"
            aria-pressed={area === room.value}
            onClick={() => {
              setArea(room.value);
              setPage(0);
            }}
            className={cn(
              "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent",
              area === room.value
                ? "bg-accent/15 text-accent"
                : "bg-hover/5 text-fg-muted hover:bg-hover/10",
            )}
          >
            {room.label}
          </button>
        ))}
      </div>
      <div ref={content} className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {error ? (
          <Alert tone="danger">
            {error instanceof Error && !("code" in error) ? error.message : errorMessage(t, error)}
          </Alert>
        ) : null}
        {state.status === "loading" ? (
          <LoadingBlock />
        ) : state.status === "unavailable" ? (
          <Alert tone="warning">{t(`widgets.reasons.${state.reason}`)}</Alert>
        ) : state.status === "error" ? (
          <Alert tone="danger">
            {state.code === "FORBIDDEN" ? t("widgets.states.forbidden") : t("widgets.states.error")}
          </Alert>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">
                {area === "__none"
                  ? t("homeAssistant.noArea")
                  : area || t("homeAssistant.yourHome")}
              </h2>
              <span className="text-xs text-fg-subtle">
                {t("homeAssistant.deviceCount", { count: groups.length })} ·{" "}
                {t("homeAssistant.entityCount", { count: entities.length })}
              </span>
            </div>
            {state.data.registry === "unavailable" ? (
              <p className="mb-4 text-xs text-fg-muted">{t("homeAssistant.registryUnavailable")}</p>
            ) : null}
            {filtered.length === 0 ? (
              <p className="p-8 text-center text-sm text-fg-muted">
                {t(entities.length ? "homeAssistant.noMatches" : "homeAssistant.noEntities")}
              </p>
            ) : (
              <div className="flex flex-col gap-6">
                {roomGroups(ordered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)).map(
                  (room) => (
                    <section
                      key={room.area ?? "__none"}
                      aria-label={room.area ?? t("homeAssistant.noArea")}
                    >
                      <div className="mb-3 flex items-center gap-2">
                        <Home className="size-4 text-accent" aria-hidden />
                        <h3 className="text-sm font-semibold">
                          {room.area ?? t("homeAssistant.noArea")}
                        </h3>
                        <span className="text-xs text-fg-subtle">
                          {t("homeAssistant.deviceCount", {
                            count: filtered.filter((group) => group.primary.area === room.area)
                              .length,
                          })}
                        </span>
                      </div>
                      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,210px),1fr))] items-stretch gap-4">
                        {room.groups.map((group) => (
                          <DeviceCard
                            key={group.id}
                            group={group}
                            integrationId={integration.id}
                            canManage={canManage}
                            onDetails={() => setSelected(group.id)}
                          />
                        ))}
                      </ul>
                    </section>
                  ),
                )}
              </div>
            )}
          </>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-5 py-2">
        <span className="text-xs text-fg-subtle">
          {state.status === "ok"
            ? t("homeAssistant.updated", { time: formatDateTime(state.at, i18n.language) })
            : t("homeAssistant.live")}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
            aria-label={t("homeAssistant.previous")}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <span className="text-xs tabular-nums">
            {t("homeAssistant.page", { page: current + 1, pages })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
            aria-label={t("homeAssistant.next")}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
      <Dialog
        open={Boolean(detail)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        className="w-[min(94vw,760px)]"
        title={detail?.name ?? t("homeAssistant.details")}
        description={t("homeAssistant.deviceDetails")}
      >
        {detail ? (
          <div className="flex flex-col gap-5">
            {detail.primary.device ? (
              <dl className="grid grid-cols-2 gap-3 rounded-everyos-md bg-hover/5 p-4 text-sm">
                <div>
                  <dt className="text-xs text-fg-subtle">{t("homeAssistant.manufacturer")}</dt>
                  <dd className="mt-1 flex items-center gap-2">
                    <BrandIcon
                      key={detail.primary.device.brand}
                      integrationId={integration.id}
                      entity={detail.primary}
                    />
                    {detail.primary.device.manufacturer ?? t("homeAssistant.notReported")}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-subtle">{t("homeAssistant.model")}</dt>
                  <dd className="mt-1">
                    {detail.primary.device.model ?? t("homeAssistant.notReported")}
                  </dd>
                </div>
              </dl>
            ) : null}
            <p className="text-xs text-fg-muted">{t("homeAssistant.extendedHelp")}</p>
            {detail.entities.map((entity) => (
              <section
                key={entity.entityId}
                className="flex flex-col gap-3 border-t border-line pt-4"
                data-entity-id={entity.entityId}
              >
                <div className="flex items-center gap-3">
                  <DeviceSymbol entity={entity} className="size-5 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-medium">{entity.name ?? entity.entityId}</h3>
                    <p className="break-all font-mono text-xs text-fg-subtle">{entity.entityId}</p>
                  </div>
                  <span role="status" className="text-sm font-medium">
                    {entityValue(t, entity)}
                  </span>
                </div>
                {entity.currentTemperature !== null ? (
                  <p className="text-xs text-fg-muted">
                    {t("homeAssistant.currentTemperature", { value: entity.currentTemperature })}
                  </p>
                ) : null}
                {canManage && (entity.actions.length || entity.controls?.length) ? (
                  <EntityControls integrationId={integration.id} entity={entity} />
                ) : (
                  <p className="text-xs text-fg-subtle">{t("homeAssistant.readOnly")}</p>
                )}
              </section>
            ))}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

export default function HomeAssistantApp() {
  const { t } = useTranslation();
  const { integrations, loading, error, reload } = useIntegrations();
  const canManage = usePermissions().includes("apps:manage");
  const connections = integrations.filter((integration) => integration.adapter === "homeassistant");
  const [selected, setSelected] = useAppStateField(
    "integrationId",
    connections.map((i) => i.id),
    connections[0]?.id ?? "",
  );
  const active = connections.find((i) => i.id === selected) ?? connections[0];
  const [dialog, setDialog] = useState<"add" | "edit" | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="home-assistant-app">
      <div className="flex shrink-0 flex-wrap items-end gap-3 border-b border-line px-5 py-3">
        <div className="min-w-48 max-w-80 flex-1">
          <Select
            label={t("homeAssistant.connection")}
            hideLabel
            value={active?.id ?? ""}
            options={connections.map((connection) => ({
              value: connection.id,
              label: connection.name,
            }))}
            onChange={setSelected}
          />
        </div>
        {active?.baseUrl ? (
          <a
            href={active.baseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-everyos-sm px-3 py-2 text-xs text-fg-muted hover:bg-hover/8 focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ExternalLink className="size-4" aria-hidden />
            {t("homeAssistant.openOriginal")}
          </a>
        ) : null}
        {canManage ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={!active}
              onClick={() => setDialog("edit")}
              aria-label={t("homeAssistant.editConnection")}
              title={t("homeAssistant.editConnection")}
            >
              <Pencil className="size-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setDialog("add")}
              aria-label={t("homeAssistant.addConnection")}
              title={t("homeAssistant.addConnection")}
            >
              <Plus className="size-4" aria-hidden />
              {!active ? t("homeAssistant.addConnection") : null}
            </Button>
          </>
        ) : null}
      </div>
      <ResourceError error={error} />
      {active ? (
        <EntityPanel
          key={`${active.id}:${active.updatedAt}`}
          integration={active}
          canManage={canManage}
        />
      ) : loading ? (
        <LoadingBlock />
      ) : !error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <Home className="size-10 text-accent" aria-hidden />
          <p className="text-sm text-fg-muted">{t("homeAssistant.noConnection")}</p>
        </div>
      ) : null}
      <IntegrationDialog
        open={dialog !== null}
        existing={dialog === "edit" ? (active ?? null) : null}
        draft={{ adapter: "homeassistant" }}
        onClose={() => setDialog(null)}
        onSaved={reload}
      />
    </div>
  );
}
