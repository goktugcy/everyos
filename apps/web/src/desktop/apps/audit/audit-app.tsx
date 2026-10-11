import type { AuditEvent, AuditPage } from "@everyos/shared";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";
import { api } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatDateTime } from "../../../lib/format.ts";

const PAGE_SIZE = 50;

const OUTCOME_CLASS: Record<AuditEvent["outcome"], string> = {
  success: "bg-success/15 text-success",
  failure: "bg-danger/15 text-danger",
  denied: "bg-warning/15 text-warning",
};

/** Read-only view of the security audit trail (requires audit:read). */
export default function AuditApp() {
  const { t, i18n } = useTranslation();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const fetchPage = useCallback(
    async (action: string, before: number | null, signal?: AbortSignal) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (before !== null) params.set("before", String(before));
      if (action) params.set("action", action);
      return api<AuditPage>(`/audit?${params.toString()}`, signal ? { signal } : {});
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchPage(applied, null, controller.signal).then(
      (page) => {
        setEvents(page.events);
        setCursor(page.nextCursor);
        setError(null);
        setLoading(false);
      },
      (caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught);
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [applied, fetchPage]);

  const loadMore = async () => {
    if (cursor === null) return;
    setLoading(true);
    try {
      const page = await fetchPage(applied, cursor);
      setEvents((current) => [...current, ...page.events]);
      setCursor(page.nextCursor);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <form
        className="flex items-center gap-2 border-b border-line p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const value = filter.trim();
          if (value === applied) return;
          setLoading(true);
          setApplied(value);
        }}
      >
        <label className="glass-inset flex h-9 flex-1 items-center gap-2 rounded-everyos-md px-3">
          <Search className="size-4 text-fg-subtle" aria-hidden />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("audit.filterPlaceholder")}
            aria-label={t("audit.filterPlaceholder")}
            className="h-full w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
          />
        </label>
        <Button type="submit" variant="secondary" size="sm">
          {t("common.search")}
        </Button>
      </form>
      {error ? (
        <div className="p-3">
          <Alert tone="danger">{errorMessage(t, error)}</Alert>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-[rgb(var(--everyos-surface)/0.95)] text-xs uppercase tracking-wider text-fg-muted">
            <tr>
              <th scope="col" className="w-8 px-3 py-2" />
              <th scope="col" className="px-3 py-2 font-semibold">
                {t("audit.time")}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                {t("audit.actor")}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                {t("audit.action")}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                {t("audit.target")}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                {t("audit.outcome")}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                {t("audit.ip")}
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <AuditRow
                key={event.id}
                event={event}
                expanded={expanded === event.id}
                onToggle={() => setExpanded((current) => (current === event.id ? null : event.id))}
                time={formatDateTime(event.ts, i18n.language, {
                  dateStyle: "short",
                  timeStyle: "medium",
                })}
              />
            ))}
          </tbody>
        </table>
        {!loading && events.length === 0 && !error ? (
          <p className="p-6 text-center text-sm text-fg-muted">{t("audit.empty")}</p>
        ) : null}
        <div className="flex justify-center p-4">
          {loading ? (
            <Spinner className="size-5 text-fg-subtle" label={t("common.loading")} />
          ) : cursor !== null ? (
            <Button variant="secondary" size="sm" onClick={() => void loadMore()}>
              {t("audit.loadMore")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AuditRow({
  event,
  expanded,
  onToggle,
  time,
}: {
  event: AuditEvent;
  expanded: boolean;
  onToggle: () => void;
  time: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <tr className="border-b border-line align-top hover:bg-hover/5">
        <td className="px-3 py-2">
          {event.details ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={t("audit.details")}
              className="grid size-6 place-items-center rounded text-fg-subtle hover:bg-hover/10"
            >
              {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </button>
          ) : null}
        </td>
        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-fg-muted">{time}</td>
        <td className="px-3 py-2">
          {event.actorUsername ?? <span className="text-fg-subtle">{t("audit.system")}</span>}
        </td>
        <td className="px-3 py-2 font-mono text-xs">{event.action}</td>
        <td className="max-w-48 truncate px-3 py-2 text-fg-muted" title={event.target ?? undefined}>
          {event.target ?? "—"}
        </td>
        <td className="px-3 py-2">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-semibold",
              OUTCOME_CLASS[event.outcome],
            )}
          >
            {t(`audit.outcomes.${event.outcome}`)}
          </span>
        </td>
        <td className="px-3 py-2 font-mono text-xs text-fg-muted">{event.ip ?? "—"}</td>
      </tr>
      {expanded && event.details ? (
        <tr className="border-b border-line">
          <td />
          <td colSpan={6} className="px-3 pb-3">
            <pre className="glass-inset overflow-x-auto rounded-everyos-sm p-3 font-mono text-xs text-fg-muted">
              {JSON.stringify(event.details, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}
