import type { ProcessList } from "@everyos/shared";
import { useTranslation } from "react-i18next";
import { Select } from "../../../components/ui/select.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { cn } from "../../../lib/cn.ts";
import { formatBytes, formatNumber } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { useAppStateField } from "../app-context.ts";
import { ContextMenuArea } from "../../menus/menus.tsx";
import { ProcessDetailPanel } from "./process-detail-panel.tsx";
import { useProcessInspector } from "./use-process-inspector.tsx";
import { LoadingBlock, ResourceError, SimulatedBadge } from "./parts.tsx";

const SORTS = ["cpu", "memory"] as const;
const LIMIT = 100;

export function ProcessesTab() {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const [sort, setSort] = useAppStateField("processSort", SORTS, "cpu");
  const list = useApiResource<ProcessList>(`/system/processes?sort=${sort}&limit=${LIMIT}`, 3_000);
  const canSeeCommands = usePermissions().includes("system:manage");
  const inspector = useProcessInspector(list.reload);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Select
          label={t("monitor.processes.sortBy")}
          value={sort}
          onChange={setSort}
          options={[
            { value: "cpu", label: t("monitor.processes.sortCpu") },
            { value: "memory", label: t("monitor.processes.sortMemory") },
          ]}
          className="w-56"
        />
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          {list.data
            ? t("monitor.processes.total", {
                count: list.data.total,
                shown: list.data.processes.length,
              })
            : null}
          <SimulatedBadge source={list.data?.source} />
        </div>
      </div>
      <ResourceError error={list.error} />
      {!canSeeCommands ? (
        <p className="text-xs text-fg-subtle">{t("monitor.processes.commandHidden")}</p>
      ) : null}
      {list.loading ? <LoadingBlock /> : null}
      {list.data ? (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-auto">
            <table className="w-full min-w-[640px] text-left text-sm" data-testid="process-table">
              <thead className="sticky top-0 z-10 bg-[rgb(var(--everyos-surface)/0.95)] text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-2 py-1.5 text-right font-semibold">
                    {t("monitor.processes.pid")}
                  </th>
                  <th scope="col" className="px-2 py-1.5 font-semibold">
                    {t("monitor.processes.name")}
                  </th>
                  <th scope="col" className="px-2 py-1.5 font-semibold">
                    {t("monitor.processes.user")}
                  </th>
                  <th
                    scope="col"
                    className={cn(
                      "px-2 py-1.5 text-right font-semibold",
                      sort === "cpu" && "text-fg",
                    )}
                    aria-sort={sort === "cpu" ? "descending" : undefined}
                  >
                    {t("monitor.processes.cpu")}
                  </th>
                  <th
                    scope="col"
                    className={cn(
                      "px-2 py-1.5 text-right font-semibold",
                      sort === "memory" && "text-fg",
                    )}
                    aria-sort={sort === "memory" ? "descending" : undefined}
                  >
                    {t("monitor.processes.memory")}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-right font-semibold">
                    {t("monitor.processes.threads")}
                  </th>
                  <th scope="col" className="px-2 py-1.5 font-semibold">
                    {t("monitor.processes.command")}
                  </th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {list.data.processes.map((process) => (
                  <ContextMenuArea
                    key={`${process.pid}:${process.startedAt}`}
                    entries={() => inspector.menu(process)}
                  >
                    <tr
                      tabIndex={0}
                      aria-selected={
                        inspector.selected?.pid === process.pid &&
                        inspector.selected.startedAt === process.startedAt
                      }
                      onClick={() => inspector.select(process)}
                      onContextMenu={() => inspector.select(process)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          inspector.select(process);
                        }
                        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))
                          inspector.select(process);
                      }}
                      className={cn(
                        "cursor-pointer border-t border-line outline-none hover:bg-hover/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                        inspector.selected?.pid === process.pid && "bg-accent/10",
                      )}
                    >
                      <td className="px-2 py-1 text-right text-fg-muted">{process.pid}</td>
                      <td className="max-w-40 truncate px-2 py-1 font-medium" title={process.name}>
                        {process.name}
                      </td>
                      <td className="max-w-28 truncate px-2 py-1 text-fg-muted">
                        {process.user ?? "—"}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {formatNumber(process.cpuPercent, language, 1)}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {formatBytes(process.memoryBytes, language)}
                      </td>
                      <td className="px-2 py-1 text-right text-fg-muted">{process.threads}</td>
                      <td
                        className="max-w-72 truncate px-2 py-1 font-mono text-xs text-fg-muted"
                        title={process.command}
                      >
                        {process.command}
                      </td>
                    </tr>
                  </ContextMenuArea>
                ))}
              </tbody>
            </table>
            {list.data.processes.length === 0 ? (
              <p className="p-6 text-center text-sm text-fg-muted">
                {t("monitor.processes.empty")}
              </p>
            ) : null}
          </div>
          <ProcessDetailPanel inspector={inspector} />
        </div>
      ) : null}
    </div>
  );
}
