import type { NetMonitor, NetMonitorCheck, NetMonitorInput } from "@everyos/app-sdk";

export interface MonitorDraft {
  id: string | null;
  name: string;
  url: string;
  method: "GET" | "HEAD";
  interval: string;
  timeout: string;
  min: string;
  max: string;
  keyword: string;
  downAfter: string;
  verifyTls: boolean;
  notify: boolean;
  enabled: boolean;
}

export const EMPTY_DRAFT: MonitorDraft = {
  id: null,
  name: "",
  url: "",
  method: "GET",
  interval: "60",
  timeout: "10000",
  min: "200",
  max: "299",
  keyword: "",
  downAfter: "1",
  verifyTls: true,
  notify: true,
  enabled: true,
};

/** Keep incomplete form input across reloads, but never trust the shape in app storage. */
export function readDraft(value: unknown): MonitorDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    !(v.id === null || (typeof v.id === "string" && v.id.length > 0 && v.id.length <= 100)) ||
    !["name", "url", "interval", "timeout", "min", "max", "keyword", "downAfter"].every(
      (key) => typeof v[key] === "string" && v[key].length <= 2048,
    ) ||
    !(v.method === "GET" || v.method === "HEAD") ||
    !["verifyTls", "notify", "enabled"].every((key) => typeof v[key] === "boolean")
  )
    return null;
  return {
    id: v.id,
    name: v.name as string,
    url: v.url as string,
    method: v.method,
    interval: v.interval as string,
    timeout: v.timeout as string,
    min: v.min as string,
    max: v.max as string,
    keyword: v.keyword as string,
    downAfter: v.downAfter as string,
    verifyTls: v.verifyTls as boolean,
    notify: v.notify as boolean,
    enabled: v.enabled as boolean,
  };
}

export function toDraft(monitor: NetMonitor): MonitorDraft {
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    method: monitor.method,
    interval: String(monitor.intervalSeconds),
    timeout: String(monitor.timeoutMs),
    min: String(monitor.expectStatus.min),
    max: String(monitor.expectStatus.max),
    keyword: monitor.keyword ?? "",
    downAfter: String(monitor.downAfter),
    verifyTls: monitor.verifyTls,
    notify: monitor.notify,
    enabled: monitor.enabled,
  };
}

const integer = (value: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
};

export type DraftError =
  "name" | "url" | "interval" | "timeout" | "status" | "keyword" | "downAfter";
export function parseDraft(
  draft: MonitorDraft,
): { input: NetMonitorInput } | { error: DraftError } {
  const name = draft.name.trim();
  if (!name || name.length > 80) return { error: "name" };
  let url: URL;
  try {
    url = new URL(draft.url.trim());
  } catch {
    return { error: "url" };
  }
  if (
    !/^(http|https):$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.href.length < 8 ||
    url.href.length > 2048
  )
    return { error: "url" };
  const intervalSeconds = integer(draft.interval, 60, 86400);
  if (intervalSeconds === null) return { error: "interval" };
  const timeoutMs = integer(draft.timeout, 1000, 30000);
  if (timeoutMs === null) return { error: "timeout" };
  const min = integer(draft.min, 100, 599);
  const max = integer(draft.max, 100, 599);
  if (min === null || max === null || min > max) return { error: "status" };
  const keyword = draft.keyword;
  if (keyword.length > 200 || (draft.method === "HEAD" && keyword)) return { error: "keyword" };
  const downAfter = integer(draft.downAfter, 1, 5);
  if (downAfter === null) return { error: "downAfter" };
  return {
    input: {
      ...(draft.id ? { id: draft.id } : {}),
      name,
      url: url.href,
      method: draft.method,
      intervalSeconds,
      timeoutMs,
      expectStatus: { min, max },
      keyword: keyword || null,
      downAfter,
      verifyTls: draft.verifyTls,
      notify: draft.notify,
      enabled: draft.enabled,
    },
  };
}

/** CSV uses fixed machine-readable columns, chronological rows and spreadsheet-safe text cells. */
export function historyCsv(monitor: NetMonitor, checks: readonly NetMonitorCheck[]): string {
  const cell = (value: string | number | null) => {
    let text = value === null ? "" : String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows: (string | number | null)[][] = [
    ["name", "url", "at_utc", "ok", "status", "ms", "error"],
    ...checks
      .toSorted((a, b) => a.at - b.at)
      .map((c) => [
        monitor.name,
        monitor.url,
        new Date(c.at).toISOString(),
        c.ok ? "true" : "false",
        c.status,
        c.ms,
        c.error,
      ]),
  ];
  return `${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function monitorInput(monitor: NetMonitor, enabled: boolean): NetMonitorInput {
  const parsed = parseDraft({ ...toDraft(monitor), enabled });
  if ("error" in parsed) throw new Error("Invalid monitor returned by host");
  return parsed.input;
}
