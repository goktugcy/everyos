import type { LogEntry, LogPage, LogQuery } from "@everyos/app-sdk";

export const MAX_ENTRIES = 1000;
export const MAX_BYTES = 4 * 1024 * 1024;
export interface Draft {
  unit: string;
  search: string;
  priority: string;
  range: string;
  since: string;
  until: string;
}
export const DEFAULT_DRAFT: Draft = {
  unit: "",
  search: "",
  priority: "all",
  range: "1h",
  since: "",
  until: "",
};
const RANGES: Record<string, number> = {
  "15m": 15 * 60000,
  "1h": 3600000,
  "24h": 86400000,
  "7d": 7 * 86400000,
};
const UNIT = /^[A-Za-z0-9][A-Za-z0-9:_.\\@-]{0,250}\.(service|socket|timer|target|path|mount)$/;

export function readDraft(value: unknown): Draft {
  if (!value || typeof value !== "object") return DEFAULT_DRAFT;
  const v = value as Record<string, unknown>;
  return {
    unit: typeof v.unit === "string" ? v.unit.slice(0, 260) : "",
    search: typeof v.search === "string" ? v.search.slice(0, 200) : "",
    priority:
      typeof v.priority === "string" && /^(all|[0-7])$/.test(v.priority) ? v.priority : "all",
    range:
      typeof v.range === "string" &&
      (Object.hasOwn(RANGES, v.range) || ["all", "custom"].includes(v.range))
        ? v.range
        : "1h",
    since: typeof v.since === "string" ? v.since.slice(0, 16) : "",
    until: typeof v.until === "string" ? v.until.slice(0, 16) : "",
  };
}
export function localTime(at: number): string {
  const d = new Date(at);
  const n = (v: number) => String(v).padStart(2, "0");
  return `${String(d.getFullYear()).padStart(4, "0")}-${n(d.getMonth() + 1)}-${n(d.getDate())}T${n(d.getHours())}:${n(d.getMinutes())}`;
}
function parseTime(value: string): number | undefined | null {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const at = new Date(value).getTime();
  return Number.isSafeInteger(at) && at >= 0 && localTime(at) === value ? at : null;
}
export function queryFor(
  draft: Draft,
  now: number,
): { query: LogQuery } | { error: "unit" | "search" | "priority" | "range" | "time" } {
  const unit = draft.unit.trim();
  if (unit && (!UNIT.test(unit) || unit.includes(".."))) return { error: "unit" };
  const search = draft.search.trim();
  if (search.length > 200 || search.includes("\0")) return { error: "search" };
  if (!/^(all|[0-7])$/.test(draft.priority)) return { error: "priority" };
  const query: LogQuery = { limit: 200 };
  if (unit) query.unit = unit;
  if (search) query.grep = search;
  if (draft.priority !== "all") query.priority = Number(draft.priority);
  if (Object.hasOwn(RANGES, draft.range))
    query.since = Math.max(0, Math.floor(now - RANGES[draft.range]!));
  else if (draft.range === "custom") {
    const since = parseTime(draft.since),
      until = parseTime(draft.until);
    if (
      since === null ||
      until === null ||
      (since === undefined && until === undefined) ||
      (since !== undefined && until !== undefined && since > until)
    )
      return { error: "time" };
    if (since !== undefined) query.since = since;
    if (until !== undefined) query.until = until;
  } else if (draft.range !== "all") return { error: "range" };
  return { query };
}

export interface Preset {
  id: string;
  name: string;
  draft: Draft;
}
export function readPresets(value: unknown): Preset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: Preset[] = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    if (
      typeof v.id !== "string" ||
      !v.id ||
      v.id.length > 100 ||
      seen.has(v.id) ||
      typeof v.name !== "string" ||
      !v.name.trim() ||
      v.name.length > 80
    )
      continue;
    if (
      !v.draft ||
      typeof v.draft !== "object" ||
      !["unit", "search", "priority", "range", "since", "until"].every(
        (key) => typeof (v.draft as Record<string, unknown>)[key] === "string",
      )
    )
      continue;
    const draft = readDraft(v.draft);
    if (
      (["unit", "search", "priority", "range", "since", "until"] as const).some(
        (key) => (v.draft as Record<string, unknown>)[key] !== draft[key],
      )
    )
      continue;
    if ("error" in queryFor(draft, Date.now())) continue;
    seen.add(v.id);
    out.push({ id: v.id, name: v.name.trim(), draft });
  }
  return out;
}

export type ReadMode = "replace" | "tail" | "older";
export interface LogView {
  source: LogPage["source"];
  entries: LogEntry[];
  hasMore: boolean;
  limited: boolean;
  gap: boolean;
  bytes: number;
  retrievedAt: number;
  query: LogQuery;
}
/** A source change starts a new view; host and simulated records never blend under one label. */
export function mergeLogs(
  previous: LogView | null,
  page: LogPage,
  mode: ReadMode,
  query: LogQuery,
  at: number,
): LogView {
  const current = mode === "replace" || previous?.source !== page.source ? null : previous;
  const candidates =
    mode === "older"
      ? [...(current?.entries ?? []), ...page.entries]
      : [...page.entries, ...(current?.entries ?? [])];
  const unique = new Map<string, LogEntry>();
  for (const entry of candidates) {
    if (query.since !== undefined && entry.ts < query.since) continue;
    if (query.until !== undefined && entry.ts > query.until) continue;
    if (!unique.has(entry.cursor)) unique.set(entry.cursor, entry);
  }
  const entries: LogEntry[] = [];
  let bytes = 0,
    dropped = false;
  const encoder = new TextEncoder();
  for (const entry of [...unique.values()].sort((a, b) => b.ts - a.ts)) {
    const size = encoder.encode(JSON.stringify(entry)).length;
    if (entries.length >= MAX_ENTRIES || bytes + size > MAX_BYTES) {
      dropped = true;
      break;
    }
    bytes += size;
    entries.push(entry);
  }
  return {
    source: page.source,
    entries,
    bytes,
    retrievedAt: at,
    query,
    hasMore: dropped || (mode === "older" || !current ? page.hasMore : current.hasMore),
    limited: dropped || (current?.limited ?? false),
    gap: (current?.gap ?? false) || (mode === "tail" && !!current && page.hasMore),
  };
}

export function logReport(view: LogView, applied: Draft, generatedAt: number) {
  return {
    version: 1,
    app: "dev.everyos.logs",
    generatedAt,
    source: view.source,
    retrievedAt: view.retrievedAt,
    filter: applied,
    query: view.query,
    hasMore: view.hasMore,
    limited: view.limited,
    gap: view.gap,
    entries: view.entries,
  };
}
