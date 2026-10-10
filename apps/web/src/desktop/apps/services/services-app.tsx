import type { ServiceAction, ServiceDetail, ServiceList, ServiceUnit } from "@otuken/shared";
import type { TFunction } from "i18next";
import { ArrowLeft, Lock, ScrollText, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes, formatDateTime, formatDuration } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { desktop } from "../../state/controller.ts";
import { useAppHost, useAppStateField } from "../app-context.ts";
import { DefinitionRows, LoadingBlock, ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { ServiceStateBadge, unitFileLabel } from "./service-state.tsx";

const FILTERS = ["all", "running", "failed", "inactive"] as const;
type Filter = (typeof FILTERS)[number];

/** Actions that interrupt a running service ask for confirmation first. */
const CONFIRMED: ReadonlySet<ServiceAction> = new Set(["stop", "restart", "reload", "disable"]);
/** The only action the agent accepts on protected units; others are not offered. */
const ALLOWED_ON_PROTECTED: ReadonlySet<ServiceAction> = new Set(["start"]);

function matches(unit: ServiceUnit, filter: Filter, query: string): boolean {
  if (filter === "running" && unit.active !== "active") return false;
  if (filter === "failed" && unit.active !== "failed") return false;
  if (filter === "inactive" && unit.active !== "inactive") return false;
  if (!query) return true;
  const needle = query.toLocaleLowerCase();
  return (
    unit.name.toLocaleLowerCase().includes(needle) ||
    unit.description.toLocaleLowerCase().includes(needle)
  );
}

/** Explains a refused action in the user's language. */
function deniedMessage(t: TFunction, error: unknown): string | null {
  if (!(error instanceof ApiRequestError) || error.code !== "AGENT_OPERATION_DENIED") return null;
  const reason = (error.details as { reason?: string } | undefined)?.reason ?? "";
  if (reason.startsWith("PROTECTED_UNIT")) return t("services.protectedHelp");
  if (reason.startsWith("DEVELOPMENT_MODE")) return t("services.developmentHint");
  return null;
}

function ServiceDetailPanel({
  unit,
  onBack,
  onChanged,
}: {
  unit: string;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const permissions = usePermissions();
  const canManage = permissions.includes("services:manage");
  const canReadLogs = permissions.includes("logs:read");
  const detail = useApiResource<ServiceDetail>(`/services/${encodeURIComponent(unit)}`, 5_000);
  const [pending, setPending] = useState<ServiceAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const data = detail.data;

  const run = async (action: ServiceAction) => {
    const label = t(`services.actions.${action}`);
    if (CONFIRMED.has(action)) {
      const ok = await requestConfirm({
        title: t("services.confirmTitle", { unit, action: label }),
        body: t(`services.confirmBody.${action as "stop"}`),
        confirmLabel: label,
        danger: action !== "reload",
      });
      if (!ok) return;
    }
    setPending(action);
    setActionError(null);
    setNotice(null);
    try {
      await api(`/services/${encodeURIComponent(unit)}/actions`, {
        method: "POST",
        body: { action },
      });
      setNotice(t("services.submitted", { action: label }));
      // systemd applies the job asynchronously (--no-block); refresh shortly after.
      for (const delay of [700, 2_500]) {
        setTimeout(() => {
          detail.reload();
          onChanged();
        }, delay);
      }
    } catch (error) {
      setActionError(error);
    } finally {
      setPending(null);
    }
  };

  const actions: ServiceAction[] = data
    ? [
        ...(data.active === "active"
          ? (["restart", "reload", "stop"] as const)
          : (["start"] as const)),
        ...(data.unitFileState === "enabled"
          ? (["disable"] as const)
          : data.unitFileState === "disabled"
            ? (["enable"] as const)
            : []),
      ]
    : [];

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4"
      data-testid="service-detail"
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onBack}
          className="grid size-8 shrink-0 place-items-center rounded-otk-sm text-fg-muted outline-none hover:bg-hover/10 focus-visible:ring-2 focus-visible:ring-accent @3xl:hidden"
          aria-label={t("common.back")}
        >
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 break-all font-mono text-base font-semibold">
            {unit}
            {data?.protected ? (
              <Lock
                className="size-4 shrink-0 text-fg-muted"
                aria-label={t("services.protected")}
              />
            ) : null}
          </h2>
          {data ? <p className="text-sm text-fg-muted">{data.description}</p> : null}
        </div>
        <SimulatedBadge source={data?.source} />
      </div>
      <ResourceError error={detail.error} />
      {detail.loading ? <LoadingBlock /> : null}
      {data ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ServiceStateBadge unit={data} />
            <span className="text-xs text-fg-muted">
              {t("services.startup")}: {unitFileLabel(t, data.unitFileState)}
            </span>
          </div>
          {data.protected ? <Alert tone="info">{t("services.protectedHelp")}</Alert> : null}
          {!canManage ? (
            <p className="text-xs text-fg-subtle">{t("services.readOnlyHint")}</p>
          ) : null}
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              {actions
                .filter((action) => !data.protected || ALLOWED_ON_PROTECTED.has(action))
                .map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant={
                      action === "stop" ? "danger" : action === "start" ? "primary" : "secondary"
                    }
                    loading={pending === action}
                    disabled={pending !== null}
                    onClick={() => void run(action)}
                  >
                    {t(`services.actions.${action}`)}
                  </Button>
                ))}
            </div>
          ) : null}
          {notice ? (
            <p role="status" className="text-sm text-fg-muted">
              {notice}
            </p>
          ) : null}
          {actionError ? (
            <Alert tone="danger">
              {deniedMessage(t, actionError) ?? errorMessage(t, actionError)}
            </Alert>
          ) : null}
          <DefinitionRows
            rows={[
              [t("services.detail.mainPid"), data.mainPid ?? "—"],
              [
                t("services.detail.activeSince"),
                data.activeSince ? formatDateTime(data.activeSince, language) : "—",
              ],
              [
                t("services.detail.memory"),
                data.memoryBytes !== null ? formatBytes(data.memoryBytes, language) : "—",
              ],
              [
                t("services.detail.cpuTime"),
                data.cpuNanoseconds !== null
                  ? formatDuration(Math.round(data.cpuNanoseconds / 1e9), language)
                  : "—",
              ],
              [t("services.detail.tasks"), data.tasks ?? "—"],
              [t("services.detail.restarts"), data.restarts ?? "—"],
              [t("services.detail.type"), data.type ?? "—"],
              [t("services.detail.restartPolicy"), data.restartPolicy ?? "—"],
              [
                t("services.detail.fragmentPath"),
                <span key="path" className="font-mono text-xs">
                  {data.fragmentPath ?? "—"}
                </span>,
              ],
            ]}
          />
          {canReadLogs ? (
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => desktop.openApp("otuken.logs", { appState: { unit } })}
              >
                <ScrollText className="size-4" aria-hidden />
                {t("services.viewLogs")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** systemd services: state, details and permitted actions. */
export default function ServicesApp() {
  const { t } = useTranslation();
  const host = useAppHost();
  const state = (host.appState ?? {}) as { unit?: unknown };
  const selected = typeof state.unit === "string" ? state.unit : null;
  const select = (unit: string | null) => host.setAppState({ ...state, unit: unit ?? undefined });
  const [filter, setFilter] = useAppStateField<Filter>("filter", FILTERS, "all");
  const [query, setQuery] = useState("");
  const list = useApiResource<ServiceList>("/services", 10_000);

  const units = useMemo(
    () => (list.data?.units ?? []).filter((unit) => matches(unit, filter, query.trim())),
    [list.data, filter, query],
  );

  return (
    <div className="@container flex h-full min-h-0">
      <div
        className={cn(
          "flex min-h-0 w-full flex-col border-line @3xl:w-[55%] @3xl:border-r",
          selected && "hidden @3xl:flex",
        )}
      >
        <div className="flex flex-col gap-2 border-b border-line p-3">
          <label className="glass-inset flex h-9 items-center gap-2 rounded-otk-md px-3">
            <Search className="size-4 text-fg-subtle" aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("services.search")}
              aria-label={t("services.search")}
              className="h-full w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <div role="group" aria-label={t("services.state")} className="flex flex-wrap gap-1">
              {FILTERS.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    filter === id
                      ? "bg-[rgb(var(--otk-accent)/0.25)] font-semibold text-fg"
                      : "text-fg-muted hover:bg-hover/10",
                  )}
                >
                  {t(`services.filters.${id}`)}
                </button>
              ))}
            </div>
            <span className="flex items-center gap-2 text-xs text-fg-subtle">
              {list.data ? t("services.count", { count: units.length }) : null}
              <SimulatedBadge source={list.data?.source} />
            </span>
          </div>
        </div>
        <div className="p-3 empty:hidden">
          <ResourceError error={list.error} />
        </div>
        {list.loading ? <LoadingBlock /> : null}
        <ul
          className="min-h-0 flex-1 overflow-y-auto"
          data-testid="service-list"
          aria-label={t("apps.services")}
        >
          {units.map((unit) => (
            <li key={unit.name}>
              <button
                type="button"
                onClick={() => select(unit.name)}
                aria-current={selected === unit.name ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left outline-none hover:bg-hover/5 focus-visible:bg-hover/10",
                  selected === unit.name && "bg-[rgb(var(--otk-accent)/0.14)]",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate font-mono text-sm text-fg">
                    {unit.name}
                    {unit.protected ? (
                      <Lock
                        className="size-3.5 shrink-0 text-fg-subtle"
                        aria-label={t("services.protected")}
                      />
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-fg-muted">
                    {unit.description || "—"}
                  </span>
                </span>
                <ServiceStateBadge unit={unit} />
              </button>
            </li>
          ))}
        </ul>
        {!list.loading && list.data && units.length === 0 ? (
          <p className="p-6 text-center text-sm text-fg-muted">{t("services.empty")}</p>
        ) : null}
      </div>
      <div className={cn("min-h-0 flex-1", !selected && "hidden @3xl:block")}>
        {selected ? (
          <ServiceDetailPanel
            key={selected}
            unit={selected}
            onBack={() => select(null)}
            onChanged={list.reload}
          />
        ) : (
          <p className="grid h-full place-items-center p-6 text-center text-sm text-fg-muted">
            {t("services.select")}
          </p>
        )}
      </div>
    </div>
  );
}
