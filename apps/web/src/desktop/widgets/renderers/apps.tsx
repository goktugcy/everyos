import type { PostgresStats } from "@everyos/shared";
import { Film, Music, Play, Power, Tv } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { cn } from "../../../lib/cn.ts";
import { formatBytes, formatDateTime, formatNumber, formatPercent } from "../../../lib/format.ts";
import { Bar, Row, Rows, Status, Value } from "../templates.tsx";
import { useTopic } from "../topics.ts";
import { Placeholder, TopicGate, type WidgetRenderProps } from "./gate.tsx";

/** The configured integration's feed (the frame renders nothing here until one is chosen). */
function useFeed<T>(props: WidgetRenderProps, feed: string) {
  const id =
    typeof props.instance.config.integration === "string" ? props.instance.config.integration : "";
  return { id, state: useTopic<T>(id ? `data.integration.${id}.${feed}` : null) };
}

function Online({ online, compact, label }: { online: boolean; compact: boolean; label: string }) {
  const { t } = useTranslation();
  const status = (
    <Status tone={online ? "ok" : "critical"}>{online ? label : t("widgets.text.offline")}</Status>
  );
  return compact ? (
    status
  ) : (
    <div className="flex h-full flex-col justify-center gap-1">{status}</div>
  );
}

/* -------------------------------- Jellyfin -------------------------------- */

export function JellyfinStatusWidget(props: WidgetRenderProps) {
  const { t } = useTranslation();
  const { state } = useFeed<{ serverName: string | null; version: string | null }>(props, "status");
  return (
    <TopicGate state={state} compact={props.compact}>
      {(status) =>
        props.compact ? (
          <Online online compact label="Jellyfin" />
        ) : (
          <div className="flex h-full flex-col justify-between gap-1">
            <Status tone="ok">{t("widgets.text.online")}</Status>
            <Value
              value={<span className="text-base">{status.serverName ?? "Jellyfin"}</span>}
              detail={
                status.version
                  ? t("widgets.text.versionValue", { version: status.version })
                  : undefined
              }
            />
          </div>
        )
      }
    </TopicGate>
  );
}

interface JellyfinSessions {
  active: number;
  streaming: number;
  sessions: Array<{
    user: string | null;
    client: string | null;
    device: string | null;
    title: string | null;
    series: string | null;
    type: string | null;
    paused: boolean;
    progress: number | null;
  }>;
}

export function JellyfinSessionsWidget(props: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { state } = useFeed<JellyfinSessions>(props, "sessions");
  return (
    <TopicGate state={state} compact={props.compact}>
      {(data) => (
        <div className="flex h-full flex-col gap-2">
          <Value
            value={formatNumber(data.streaming, i18n.language)}
            label={t("widgets.text.nowPlaying")}
            detail={t("widgets.text.activeSessions", { count: data.active })}
          />
          <Rows className="gap-2">
            {data.sessions.slice(0, props.size === "large" ? 6 : 2).map((session, index) => (
              <li key={index} className="flex flex-col gap-1">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate font-medium text-fg">
                    {session.series ? `${session.series} · ${session.title ?? ""}` : session.title}
                  </span>
                  <span className="shrink-0 text-fg-subtle">
                    {session.paused ? t("widgets.text.paused") : null}
                  </span>
                </div>
                <span className="truncate text-fg-subtle">
                  {[session.user, session.device ?? session.client].filter(Boolean).join(" · ")}
                </span>
                {session.progress !== null ? (
                  <Bar percent={session.progress * 100} warnAt={101} dangerAt={101} />
                ) : null}
              </li>
            ))}
          </Rows>
        </div>
      )}
    </TopicGate>
  );
}

export function JellyfinLibraryWidget(props: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { state } = useFeed<
    Record<"movies" | "series" | "episodes" | "albums" | "songs" | "books", number>
  >(props, "library");
  const n = (v: number) => formatNumber(v, i18n.language);
  return (
    <TopicGate state={state} compact={props.compact}>
      {(counts) => (
        <Rows>
          <Row
            label={
              <span className="flex items-center gap-1.5">
                <Film className="size-3.5" aria-hidden />
                {t("widgets.text.movies")}
              </span>
            }
            value={n(counts.movies)}
          />
          <Row
            label={
              <span className="flex items-center gap-1.5">
                <Tv className="size-3.5" aria-hidden />
                {t("widgets.text.series")}
              </span>
            }
            value={n(counts.series)}
          />
          {props.size !== "small" ? (
            <Row label={t("widgets.text.episodes")} value={n(counts.episodes)} />
          ) : null}
          <Row
            label={
              <span className="flex items-center gap-1.5">
                <Music className="size-3.5" aria-hidden />
                {t("widgets.text.songs")}
              </span>
            }
            value={n(counts.songs)}
          />
          {props.size !== "small" ? (
            <Row label={t("widgets.text.books")} value={n(counts.books)} />
          ) : null}
        </Rows>
      )}
    </TopicGate>
  );
}

/* --------------------------------- Immich --------------------------------- */

export function ImmichStatusWidget(props: WidgetRenderProps) {
  const { t } = useTranslation();
  const { state } = useFeed<{ online: boolean; version: string | null }>(props, "status");
  return (
    <TopicGate state={state} compact={props.compact}>
      {(status) =>
        props.compact ? (
          <Online online={status.online} compact label="Immich" />
        ) : (
          <div className="flex h-full flex-col justify-between gap-1">
            <Status tone={status.online ? "ok" : "critical"}>
              {status.online ? t("widgets.text.online") : t("widgets.text.offline")}
            </Status>
            <Value
              value={<span className="text-base">Immich</span>}
              detail={
                status.version
                  ? t("widgets.text.versionValue", { version: status.version })
                  : undefined
              }
            />
          </div>
        )
      }
    </TopicGate>
  );
}

export function ImmichStorageWidget(props: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { state } = useFeed<{ totalBytes: number; usedBytes: number; availableBytes: number }>(
    props,
    "storage",
  );
  return (
    <TopicGate state={state} compact={props.compact}>
      {(storage) => {
        const percent = storage.totalBytes > 0 ? (storage.usedBytes / storage.totalBytes) * 100 : 0;
        return (
          <div className="flex h-full flex-col justify-between gap-2">
            <Value
              label={t("widgets.text.libraryDisk")}
              value={formatPercent(percent, i18n.language)}
              detail={t("monitor.usedOf", {
                used: formatBytes(storage.usedBytes, i18n.language),
                total: formatBytes(storage.totalBytes, i18n.language),
              })}
            />
            <Bar percent={percent} />
          </div>
        );
      }}
    </TopicGate>
  );
}

export function ImmichStatisticsWidget(props: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { state } = useFeed<{ photos: number; videos: number; usageBytes: number }>(
    props,
    "statistics",
  );
  return (
    <TopicGate state={state} compact={props.compact}>
      {(stats) => (
        <Rows>
          <Row label={t("widgets.text.photos")} value={formatNumber(stats.photos, i18n.language)} />
          <Row label={t("widgets.text.videos")} value={formatNumber(stats.videos, i18n.language)} />
          <Row
            label={t("widgets.text.usage")}
            value={formatBytes(stats.usageBytes, i18n.language)}
          />
        </Rows>
      )}
    </TopicGate>
  );
}

/* ------------------------------ Home Assistant ------------------------------ */

interface HomeAssistantStates {
  entities: Array<{
    entityId: string;
    name: string | null;
    state: string;
    unit: string | null;
    deviceClass: string | null;
    lastChanged: number | null;
  }>;
  controllable: string[];
}

function selectedEntities(props: WidgetRenderProps): string[] {
  const value = props.instance.config.entities;
  return Array.isArray(value) ? value : [];
}

function entityValue(
  entity: HomeAssistantStates["entities"][number],
  t: (key: "widgets.text.haUnavailable") => string,
): string {
  if (entity.state === "unavailable" || entity.state === "unknown")
    return t("widgets.text.haUnavailable");
  return entity.unit ? `${entity.state} ${entity.unit}` : entity.state;
}

export function HomeAssistantEntitiesWidget(props: WidgetRenderProps) {
  const { t } = useTranslation();
  const { state } = useFeed<HomeAssistantStates>(props, "states");
  const wanted = selectedEntities(props);
  return (
    <TopicGate state={state} compact={props.compact}>
      {(data) => {
        const entities = wanted
          .map((id) => data.entities.find((e) => e.entityId === id))
          .filter((e) => e !== undefined);
        if (entities.length === 0)
          return (
            <Placeholder compact={props.compact}>{t("widgets.text.entitiesNotShared")}</Placeholder>
          );
        return (
          <Rows>
            {entities.map((entity) => (
              <Row
                key={entity.entityId}
                label={entity.name ?? entity.entityId}
                value={entityValue(entity, t)}
                title={entity.entityId}
              />
            ))}
          </Rows>
        );
      }}
    </TopicGate>
  );
}

export function HomeAssistantAutomationsWidget(props: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { state } = useFeed<{
    total: number;
    on: number;
    off: number;
    unavailable: number;
    items: Array<{
      entityId: string;
      name: string | null;
      state: string;
      lastTriggered: number | null;
    }>;
  }>(props, "automations");
  return (
    <TopicGate state={state} compact={props.compact}>
      {(data) => (
        <div className="flex h-full flex-col gap-2">
          <Value
            value={`${formatNumber(data.on, i18n.language)} / ${formatNumber(data.total, i18n.language)}`}
            label={t("widgets.text.automationsOn")}
          />
          {data.unavailable > 0 ? (
            <Status tone="warning">
              {t("widgets.text.automationsUnavailable", { count: data.unavailable })}
            </Status>
          ) : null}
          {props.size !== "small" ? (
            <Rows>
              {[...data.items]
                .filter((item) => item.lastTriggered !== null)
                .sort((a, b) => (b.lastTriggered ?? 0) - (a.lastTriggered ?? 0))
                .slice(0, 4)
                .map((item) => (
                  <Row
                    key={item.entityId}
                    label={item.name ?? item.entityId}
                    value={formatDateTime(item.lastTriggered!, i18n.language, {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  />
                ))}
            </Rows>
          ) : null}
        </div>
      )}
    </TopicGate>
  );
}

const SWITCHABLE = /^(switch|light|input_boolean|fan)\./;

export function HomeAssistantControlsWidget(props: WidgetRenderProps) {
  const { t } = useTranslation();
  const { id, state } = useFeed<HomeAssistantStates>(props, "states");
  const wanted = selectedEntities(props);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (entityId: string) => {
    setPending(entityId);
    setError(null);
    try {
      await api(`/integrations/${id}/actions`, {
        method: "POST",
        body: { entityId, service: "toggle" },
      });
    } catch (cause) {
      setError(errorMessage(t, cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <TopicGate state={state} compact={props.compact}>
      {(data) => {
        const entities = wanted
          .filter((entityId) => data.controllable.includes(entityId))
          .map((entityId) => data.entities.find((e) => e.entityId === entityId))
          .filter((e) => e !== undefined);
        if (entities.length === 0)
          return (
            <Placeholder compact={props.compact}>{t("widgets.text.entitiesNotShared")}</Placeholder>
          );
        return (
          <div className="flex h-full flex-col gap-1.5">
            <ul
              className={cn("grid gap-1.5", props.size === "small" ? "grid-cols-1" : "grid-cols-2")}
            >
              {entities.map((entity) => {
                const unavailable = entity.state === "unavailable" || entity.state === "unknown";
                const on = entity.state === "on" || entity.state === "open";
                const script = entity.entityId.startsWith("script.");
                return (
                  <li key={entity.entityId}>
                    <button
                      type="button"
                      disabled={unavailable || pending !== null}
                      {...(script ? {} : { "aria-pressed": on })}
                      title={entity.entityId}
                      onClick={() => void run(entity.entityId)}
                      className={cn(
                        "flex w-full min-w-0 items-center gap-1.5 rounded-everyos-sm px-2 py-1.5 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50",
                        on ? "button-accent" : "bg-hover/8 text-fg hover:bg-hover/14",
                      )}
                    >
                      {script ? (
                        <Play className="size-3.5 shrink-0" aria-hidden />
                      ) : (
                        <Power className="size-3.5 shrink-0" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {entity.name ?? entity.entityId}
                      </span>
                      <span className="shrink-0 text-[0.7rem] opacity-80">
                        {unavailable
                          ? t("widgets.text.haUnavailable")
                          : script
                            ? t("widgets.text.run")
                            : SWITCHABLE.test(entity.entityId)
                              ? on
                                ? t("common.on")
                                : t("common.off")
                              : entity.state}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {error ? (
              <p className="text-xs text-danger" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        );
      }}
    </TopicGate>
  );
}

/* ------------------------------- Uptime Kuma ------------------------------- */

interface KumaMonitors {
  up: number;
  down: number;
  pending: number;
  maintenance: number;
  monitors: Array<{
    name: string;
    type: string | null;
    status: "down" | "up" | "pending" | "maintenance";
    responseMs: number | null;
  }>;
}

const KUMA_TONE = {
  up: "ok",
  down: "critical",
  pending: "warning",
  maintenance: "neutral",
} as const;

export function UptimeKumaMonitorsWidget(props: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { state } = useFeed<KumaMonitors>(props, "monitors");
  return (
    <TopicGate state={state} compact={props.compact}>
      {(data) => (
        <div className="flex h-full flex-col gap-2">
          <Value
            value={`${formatNumber(data.up, i18n.language)} / ${formatNumber(data.monitors.length, i18n.language)}`}
            label={t("widgets.text.monitorsUp")}
          />
          <Rows>
            {[...data.monitors]
              .sort((a, b) => Number(b.status === "down") - Number(a.status === "down"))
              .slice(0, props.size === "large" ? 12 : 4)
              .map((monitor) => (
                <Row
                  key={monitor.name}
                  label={<Status tone={KUMA_TONE[monitor.status]}>{monitor.name}</Status>}
                  value={
                    monitor.status === "up" && monitor.responseMs !== null
                      ? `${formatNumber(monitor.responseMs, i18n.language)} ms`
                      : t(`widgets.kuma.${monitor.status}`)
                  }
                />
              ))}
          </Rows>
        </div>
      )}
    </TopicGate>
  );
}

export function UptimeKumaIncidentsWidget(props: WidgetRenderProps) {
  const { t } = useTranslation();
  const { state } = useFeed<KumaMonitors>(props, "monitors");
  return (
    <TopicGate state={state} compact={props.compact}>
      {(data) => {
        const status =
          data.down > 0 ? (
            <Status tone="critical">{t("widgets.text.monitorsDown", { count: data.down })}</Status>
          ) : (
            <Status tone="ok">{t("widgets.text.allMonitorsUp")}</Status>
          );
        if (props.compact) return status;
        return (
          <div className="flex h-full flex-col gap-1.5">
            {status}
            <Rows>
              {data.monitors
                .filter((m) => m.status === "down")
                .slice(0, 3)
                .map((m) => (
                  <Row key={m.name} label={m.name} />
                ))}
            </Rows>
          </div>
        );
      }}
    </TopicGate>
  );
}

/* -------------------------------- Nextcloud -------------------------------- */

export function NextcloudStatusWidget(props: WidgetRenderProps) {
  const { t } = useTranslation();
  const { state } = useFeed<{ installed: boolean; maintenance: boolean; version: string | null }>(
    props,
    "status",
  );
  return (
    <TopicGate state={state} compact={props.compact}>
      {(status) => {
        const badge = status.maintenance ? (
          <Status tone="warning">{t("widgets.text.maintenance")}</Status>
        ) : (
          <Status tone="ok">{props.compact ? "Nextcloud" : t("widgets.text.online")}</Status>
        );
        if (props.compact) return badge;
        return (
          <div className="flex h-full flex-col justify-between gap-1">
            {badge}
            <Value
              value={<span className="text-base">Nextcloud</span>}
              detail={
                status.version
                  ? t("widgets.text.versionValue", { version: status.version })
                  : undefined
              }
            />
          </div>
        );
      }}
    </TopicGate>
  );
}

export function NextcloudStorageWidget(props: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { state } = useFeed<{
    version: string | null;
    users: number;
    files: number;
    freeBytes: number | null;
    activeUsers24h: number | null;
  }>(props, "serverinfo");
  return (
    <TopicGate state={state} compact={props.compact}>
      {(info) => (
        <Rows>
          <Row label={t("widgets.text.files")} value={formatNumber(info.files, i18n.language)} />
          <Row label={t("widgets.text.users")} value={formatNumber(info.users, i18n.language)} />
          <Row
            label={t("widgets.text.freeSpace")}
            value={info.freeBytes === null ? "—" : formatBytes(info.freeBytes, i18n.language)}
          />
          {props.size !== "small" ? (
            <Row
              label={t("widgets.text.activeToday")}
              value={
                info.activeUsers24h === null
                  ? "—"
                  : formatNumber(info.activeUsers24h, i18n.language)
              }
            />
          ) : null}
        </Rows>
      )}
    </TopicGate>
  );
}

/* -------------------------------- PostgreSQL -------------------------------- */

export function PostgresStatsWidget(props: WidgetRenderProps) {
  const { t, i18n } = useTranslation();
  const { state } = useFeed<{
    container: { state: string; health: string };
    stats: PostgresStats | null;
  }>(props, "stats");
  return (
    <TopicGate state={state} compact={props.compact}>
      {(data) => {
        if (!data.stats)
          return (
            <Placeholder compact={props.compact}>{t("widgets.text.containerStopped")}</Placeholder>
          );
        const percent =
          data.stats.maxConnections > 0
            ? (data.stats.connections / data.stats.maxConnections) * 100
            : 0;
        return (
          <div className="flex h-full flex-col gap-2">
            <Value
              label={t("widgets.text.connections")}
              value={`${formatNumber(data.stats.connections, i18n.language)} / ${formatNumber(data.stats.maxConnections, i18n.language)}`}
            />
            <Bar percent={percent} />
            {props.size !== "small" ? (
              <Rows>
                {[...data.stats.databases]
                  .sort((a, b) => b.sizeBytes - a.sizeBytes)
                  .slice(0, 4)
                  .map((db) => (
                    <Row
                      key={db.name}
                      label={<span className="font-mono">{db.name}</span>}
                      value={formatBytes(db.sizeBytes, i18n.language)}
                    />
                  ))}
              </Rows>
            ) : null}
          </div>
        );
      }}
    </TopicGate>
  );
}
