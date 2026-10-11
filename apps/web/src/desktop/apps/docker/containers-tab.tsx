import type { ContainerList, DockerContainerView } from "@everyos/shared";
import { Lock, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLiveDocker } from "../../../features/docker/live-docker.ts";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { cn } from "../../../lib/cn.ts";
import { formatBytes, formatPercent } from "../../../lib/format.ts";
import { useAppHost, useAppStateField } from "../app-context.ts";
import { LoadingBlock, ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { HealthBadge, OwnershipBadge, StateBadge } from "./badges.tsx";
import { ContainerDetailPanel } from "./container-detail.tsx";

const FILTERS = ["all", "running", "stopped", "attention"] as const;
type Filter = (typeof FILTERS)[number];

type ContainerListView = Omit<ContainerList, "containers"> & { containers: DockerContainerView[] };

function matches(container: DockerContainerView, filter: Filter, query: string): boolean {
  if (filter === "running" && container.state !== "running") return false;
  if (filter === "stopped" && container.state === "running") return false;
  if (
    filter === "attention" &&
    container.health !== "unhealthy" &&
    container.state !== "dead" &&
    container.state !== "restarting"
  )
    return false;
  if (!query) return true;
  const needle = query.toLocaleLowerCase();
  return [container.name, container.image, container.project ?? ""].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

function ContainerRow({
  container,
  selected,
  onSelect,
}: {
  container: DockerContainerView;
  selected: boolean;
  onSelect: () => void;
}) {
  const { i18n } = useTranslation();
  const stats = useLiveDocker((state) => state.stats?.containers[container.id]);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-left outline-none hover:bg-hover/5 focus-visible:bg-hover/10",
        selected && "bg-[rgb(var(--everyos-accent)/0.14)]",
      )}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
          {container.name}
          {container.protected ? (
            <Lock className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          ) : null}
        </span>
        <span className="block truncate font-mono text-xs text-fg-muted">{container.image}</span>
      </span>
      <span className="flex flex-wrap items-center justify-end gap-1.5">
        <HealthBadge health={container.health} />
        <StateBadge state={container.state} />
      </span>
      {container.state === "running" && stats ? (
        <span className="col-span-2 text-xs tabular-nums text-fg-subtle">
          CPU {stats.cpuPercent !== null ? formatPercent(stats.cpuPercent, i18n.language, 1) : "—"}{" "}
          · RAM {formatBytes(stats.memoryBytes, i18n.language)}
        </span>
      ) : null}
    </button>
  );
}

export function ContainersTab({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const host = useAppHost();
  const state = (host.appState ?? {}) as { container?: unknown };
  const selected = typeof state.container === "string" ? state.container : null;
  const select = (id: string | null) => host.setAppState({ ...state, container: id ?? undefined });
  const [filter, setFilter] = useAppStateField<Filter>("containerFilter", FILTERS, "all");
  const [query, setQuery] = useState("");
  const list = useApiResource<ContainerListView>("/docker/containers", 30_000, refreshKey);

  const groups = useMemo(() => {
    const visible = (list.data?.containers ?? []).filter((c) => matches(c, filter, query.trim()));
    const byProject = new Map<string, DockerContainerView[]>();
    for (const container of visible) {
      const key = container.project ?? "";
      byProject.set(key, [...(byProject.get(key) ?? []), container]);
    }
    return [...byProject].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [list.data, filter, query]);
  const count = groups.reduce((total, [, items]) => total + items.length, 0);

  return (
    <div className="flex h-full min-h-0">
      <div
        className={cn(
          "flex min-h-0 w-full flex-col border-line @3xl:w-[48%] @3xl:border-r",
          selected && "hidden @3xl:flex",
        )}
      >
        <div className="flex flex-col gap-2 border-b border-line p-3">
          <label className="glass-inset flex h-9 items-center gap-2 rounded-everyos-md px-3">
            <Search className="size-4 text-fg-subtle" aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("docker.search")}
              aria-label={t("docker.search")}
              className="h-full w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <div
              role="group"
              aria-label={t("docker.tabs.containers")}
              className="flex flex-wrap gap-1"
            >
              {FILTERS.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    filter === id
                      ? "bg-[rgb(var(--everyos-accent)/0.25)] font-semibold text-fg"
                      : "text-fg-muted hover:bg-hover/10",
                  )}
                >
                  {t(`docker.filters.${id}`)}
                </button>
              ))}
            </div>
            <span className="flex items-center gap-2 text-xs text-fg-subtle">
              {list.data ? t("docker.count", { count }) : null}
              <SimulatedBadge source={list.data?.source} />
            </span>
          </div>
        </div>
        <div className="p-3 empty:hidden">
          <ResourceError error={list.error} />
        </div>
        {list.loading ? <LoadingBlock /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="container-list">
          {groups.map(([project, items]) => (
            <section key={project || "standalone"} aria-label={project || t("docker.standalone")}>
              <h3 className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-[rgb(var(--everyos-surface))] px-3 py-1.5 text-xs font-semibold text-fg-muted">
                <span className="truncate">{project || t("docker.standalone")}</span>
                {items[0] ? <OwnershipBadge ownership={items[0].ownership} /> : null}
              </h3>
              {items.map((container) => (
                <ContainerRow
                  key={container.id}
                  container={container}
                  selected={selected === container.id}
                  onSelect={() => select(container.id)}
                />
              ))}
            </section>
          ))}
          {!list.loading && list.data && count === 0 ? (
            <p className="p-6 text-center text-sm text-fg-muted">{t("docker.empty")}</p>
          ) : null}
        </div>
      </div>
      <div className={cn("min-h-0 flex-1", !selected && "hidden @3xl:block")}>
        {selected ? (
          <ContainerDetailPanel
            key={selected}
            id={selected}
            refreshKey={refreshKey}
            onBack={() => select(null)}
            onChanged={list.reload}
          />
        ) : (
          <p className="grid h-full place-items-center p-6 text-center text-sm text-fg-muted">
            {t("docker.select")}
          </p>
        )}
      </div>
    </div>
  );
}
