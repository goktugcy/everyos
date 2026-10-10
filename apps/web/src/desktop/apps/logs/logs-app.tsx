import { LOG_PRIORITIES, type LogEntry, type LogPage } from "@otuken/shared";
import { Pause, Play, Search } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";
import { api } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatClock, formatDateTime } from "../../../lib/format.ts";
import { useAppHost } from "../app-context.ts";
import { SimulatedBadge } from "../system/parts.tsx";

const PAGE_SIZE = 200;
/** Entries kept on screen; older ones are dropped from the live view. */
const MAX_ENTRIES = 2_000;
const PRIORITY_VALUES = ["", "0", "1", "2", "3", "4", "5", "6", "7"] as const;
type PriorityValue = (typeof PRIORITY_VALUES)[number];

interface Filters {
  unit: string;
  priority: PriorityValue;
  grep: string;
}

function readFilters(state: unknown): Filters {
  const raw = (state ?? {}) as Record<string, unknown>;
  const priority =
    typeof raw.priority === "string" &&
    (PRIORITY_VALUES as readonly string[]).includes(raw.priority)
      ? (raw.priority as PriorityValue)
      : "";
  return {
    unit: typeof raw.unit === "string" ? raw.unit : "",
    priority,
    grep: typeof raw.grep === "string" ? raw.grep : "",
  };
}

function queryString(filters: Filters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (filters.unit) params.set("unit", filters.unit);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.grep) params.set("grep", filters.grep);
  return params.toString();
}

function priorityClass(priority: number): string {
  if (priority <= 3) return "bg-danger/15 text-danger";
  if (priority === 4) return "bg-warning/15 text-warning";
  if (priority === 7) return "text-fg-subtle";
  return "bg-hover/8 text-fg-muted";
}

function EntryRow({ entry }: { entry: LogEntry }) {
  const { t, i18n } = useTranslation();
  const name = LOG_PRIORITIES[entry.priority] ?? "info";
  return (
    <li className="grid grid-cols-[4.25rem_6.5rem_minmax(0,1fr)] gap-x-3 border-b border-line px-3 py-1.5 text-sm [content-visibility:auto] @2xl:grid-cols-[4.25rem_6.5rem_10rem_minmax(0,1fr)]">
      <time
        dateTime={new Date(entry.ts).toISOString()}
        title={formatDateTime(entry.ts, i18n.language, {
          dateStyle: "medium",
          timeStyle: "medium",
        })}
        className="whitespace-nowrap pt-0.5 text-xs tabular-nums text-fg-muted"
      >
        {formatClock(entry.ts, i18n.language, true)}
      </time>
      <span
        className={cn(
          "h-fit w-fit max-w-full truncate whitespace-nowrap rounded-full px-2 py-0.5 text-[0.7rem] font-semibold",
          priorityClass(entry.priority),
        )}
      >
        {t(`logs.priorities.${name}`)}
      </span>
      <span
        className="hidden truncate pt-0.5 font-mono text-xs text-fg-muted @2xl:block"
        title={entry.unit ?? entry.identifier ?? undefined}
      >
        {entry.unit ?? entry.identifier ?? "—"}
      </span>
      <span className="col-span-3 min-w-0 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-fg @2xl:col-span-1">
        <span className="text-fg-muted @2xl:hidden">{entry.unit ?? entry.identifier ?? ""} </span>
        {entry.message}
      </span>
    </li>
  );
}

/** journald viewer: filters, older pages and a live tail. */
export default function LogsApp() {
  const { t } = useTranslation();
  const host = useAppHost();
  const applied = readFilters(host.appState);
  const key = queryString(applied);
  const [draft, setDraft] = useState<Filters>(applied);
  const [draftKey, setDraftKey] = useState(key);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [source, setSource] = useState<"host" | "simulated" | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [live, setLive] = useState(false);
  const [streamState, setStreamState] = useState<"idle" | "open" | "reconnecting">("idle");
  const seen = useRef(new Set<string>());

  // New applied filters (from this form or e.g. "Show logs" in the Services
  // app) replace the draft and start a fresh load.
  if (draftKey !== key) {
    setDraftKey(key);
    setDraft(applied);
    setLoading(true);
  }

  useEffect(() => {
    const controller = new AbortController();
    api<LogPage>(`/logs?${queryString(readFilters(host.appState), { limit: String(PAGE_SIZE) })}`, {
      signal: controller.signal,
    }).then(
      (page) => {
        seen.current = new Set(page.entries.map((entry) => entry.cursor));
        setEntries(page.entries);
        setHasMore(page.hasMore);
        setSource(page.source);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the applied filters
  }, [key]);

  useEffect(() => {
    if (!live) return;
    const events = new EventSource(`/api/logs/stream?${key}`);
    events.addEventListener("ready", () => setStreamState("open"));
    events.addEventListener("entry", (event) => {
      const entry = JSON.parse((event as MessageEvent<string>).data) as LogEntry;
      if (seen.current.has(entry.cursor)) return;
      seen.current.add(entry.cursor);
      setEntries((current) => [entry, ...current].slice(0, MAX_ENTRIES));
    });
    events.addEventListener("end", () => setStreamState("reconnecting"));
    events.onerror = () => {
      setStreamState("reconnecting");
      if (events.readyState === EventSource.CLOSED) {
        // Refused (locked, signed out, no journald): surface it through a normal request.
        api(`/logs?${queryString(readFilters(host.appState), { limit: "1" })}`).catch(
          (caught: unknown) => setError(caught),
        );
        setLive(false);
      }
    };
    return () => {
      events.close();
      setStreamState("idle");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the applied filters
  }, [live, key]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    host.setAppState({
      unit: draft.unit.trim() || undefined,
      priority: draft.priority || undefined,
      grep: draft.grep.trim() || undefined,
    });
  };

  const loadOlder = async () => {
    const last = entries.at(-1);
    if (!last) return;
    setLoading(true);
    try {
      const page = await api<LogPage>(
        `/logs?${queryString(applied, { limit: String(PAGE_SIZE), before: last.cursor })}`,
      );
      const fresh = page.entries.filter((entry) => !seen.current.has(entry.cursor));
      for (const entry of fresh) seen.current.add(entry.cursor);
      setEntries((current) => [...current, ...fresh].slice(0, MAX_ENTRIES));
      setHasMore(page.hasMore && entries.length + fresh.length < MAX_ENTRIES);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <form onSubmit={apply} className="flex flex-wrap items-end gap-2 border-b border-line p-3">
        <label className="flex min-w-40 flex-1 flex-col gap-1.5">
          <span className="text-[0.8rem] font-medium text-fg-muted">{t("logs.unit")}</span>
          <input
            value={draft.unit}
            onChange={(event) => setDraft({ ...draft, unit: event.target.value })}
            placeholder={t("logs.unitPlaceholder")}
            className="glass-inset h-10 rounded-otk-md px-3 font-mono text-sm text-fg outline-none placeholder:font-sans placeholder:text-fg-subtle"
            spellCheck={false}
            autoCapitalize="off"
          />
        </label>
        <Select
          label={t("logs.priority")}
          value={draft.priority}
          onChange={(priority) => setDraft({ ...draft, priority })}
          options={PRIORITY_VALUES.map((value) => ({
            value,
            label:
              value === ""
                ? t("logs.anyPriority")
                : t("logs.atLeast", {
                    level: t(`logs.priorities.${LOG_PRIORITIES[Number(value)]!}`),
                  }),
          }))}
          className="w-52"
        />
        <label className="flex min-w-40 flex-1 flex-col gap-1.5">
          <span className="text-[0.8rem] font-medium text-fg-muted">{t("logs.search")}</span>
          <span className="glass-inset flex h-10 items-center gap-2 rounded-otk-md px-3">
            <Search className="size-4 text-fg-subtle" aria-hidden />
            <input
              value={draft.grep}
              onChange={(event) => setDraft({ ...draft, grep: event.target.value })}
              maxLength={200}
              className="h-full w-full bg-transparent text-sm text-fg outline-none"
            />
          </span>
        </label>
        <Button type="submit" variant="secondary">
          {t("logs.apply")}
        </Button>
        <Button
          type="button"
          variant={live ? "primary" : "secondary"}
          aria-pressed={live}
          onClick={() => setLive((value) => !value)}
          data-testid="logs-live"
        >
          {live ? (
            <Pause className="size-4" aria-hidden />
          ) : (
            <Play className="size-4" aria-hidden />
          )}
          {live ? t("logs.liveOn") : t("logs.live")}
        </Button>
      </form>
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-fg-subtle">
        <span role="status">
          {live && streamState === "reconnecting" ? t("logs.reconnecting") : null}
          {entries.length >= MAX_ENTRIES ? t("logs.capped", { count: MAX_ENTRIES }) : null}
        </span>
        <SimulatedBadge source={source} />
      </div>
      {error ? (
        <div className="px-3 pb-2">
          <Alert tone="danger">{errorMessage(t, error)}</Alert>
        </div>
      ) : null}
      <ol
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="log-list"
        aria-label={t("apps.logs")}
      >
        {entries.map((entry) => (
          <EntryRow key={entry.cursor} entry={entry} />
        ))}
      </ol>
      {!loading && entries.length === 0 && !error ? (
        <p className="p-6 text-center text-sm text-fg-muted">{t("logs.empty")}</p>
      ) : null}
      <div className="flex justify-center border-t border-line p-2 empty:hidden">
        {loading ? (
          <Spinner className="size-5 text-fg-subtle" label={t("common.loading")} />
        ) : hasMore ? (
          <Button size="sm" variant="secondary" onClick={() => void loadOlder()}>
            {t("logs.loadOlder")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
