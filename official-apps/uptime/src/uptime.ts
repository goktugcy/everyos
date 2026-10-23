import {
  NET_LIMITS,
  type NetMonitor,
  type NetMonitorCheck,
  type NetMonitorInput,
  type SystemInfo,
  type SystemServices,
} from "@everyos/app-sdk";

export type Health = "up" | "down" | "degraded" | "unknown";
export type EndpointDraft = {
  id: string | null;
  name: string;
  url: string;
  interval: string;
  timeout: string;
  min: string;
  max: string;
  downAfter: string;
  notify: boolean;
  enabled: boolean;
};
export const EMPTY_DRAFT: EndpointDraft = {
  id: null,
  name: "",
  url: "",
  interval: "60",
  timeout: "10000",
  min: "200",
  max: "299",
  downAfter: "1",
  notify: true,
  enabled: true,
};
export type DraftError = "name" | "url" | "interval" | "timeout" | "status" | "downAfter";

export function readDraft(value: unknown): EndpointDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const strings = ["name", "url", "interval", "timeout", "min", "max", "downAfter"];
  if (
    !(
      raw.id === null ||
      (typeof raw.id === "string" && raw.id.length > 0 && raw.id.length <= 100)
    ) ||
    !strings.every((key) => typeof raw[key] === "string" && raw[key].length <= 2048) ||
    typeof raw.notify !== "boolean" ||
    typeof raw.enabled !== "boolean"
  )
    return null;
  return {
    id: raw.id,
    name: raw.name as string,
    url: raw.url as string,
    interval: raw.interval as string,
    timeout: raw.timeout as string,
    min: raw.min as string,
    max: raw.max as string,
    downAfter: raw.downAfter as string,
    notify: raw.notify,
    enabled: raw.enabled,
  };
}
export const toDraft = (monitor: NetMonitor): EndpointDraft => ({
  id: monitor.id,
  name: monitor.name,
  url: monitor.url,
  interval: String(monitor.intervalSeconds),
  timeout: String(monitor.timeoutMs),
  min: String(monitor.expectStatus.min),
  max: String(monitor.expectStatus.max),
  downAfter: String(monitor.downAfter),
  notify: monitor.notify,
  enabled: monitor.enabled,
});
const integer = (value: string, min: number, max: number) => {
  if (!/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= min && result <= max ? result : null;
};
export function parseDraft(
  draft: EndpointDraft,
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
    url.href.length > 2048 ||
    url.href.length < 8
  )
    return { error: "url" };
  const intervalSeconds = integer(
    draft.interval,
    NET_LIMITS.monitorIntervalSeconds.min,
    NET_LIMITS.monitorIntervalSeconds.max,
  );
  if (intervalSeconds === null) return { error: "interval" };
  const timeoutMs = integer(draft.timeout, 1000, 30000);
  if (timeoutMs === null) return { error: "timeout" };
  const min = integer(draft.min, 100, 599),
    max = integer(draft.max, 100, 599);
  if (min === null || max === null || min > max) return { error: "status" };
  const downAfter = integer(draft.downAfter, 1, 5);
  if (downAfter === null) return { error: "downAfter" };
  return {
    input: {
      ...(draft.id ? { id: draft.id } : {}),
      name,
      url: url.href,
      method: "GET",
      intervalSeconds,
      timeoutMs,
      expectStatus: { min, max },
      downAfter,
      keyword: null,
      verifyTls: true,
      notify: draft.notify,
      enabled: draft.enabled,
    },
  };
}

export function healthSummary(
  info: SystemInfo | null,
  services: SystemServices | null,
  monitors: readonly NetMonitor[] | null,
  stale: boolean,
  now: number,
) {
  const active = monitors?.filter((value) => value.enabled) ?? [];
  const counts = { up: 0, down: 0, blocked: 0, pending: 0, paused: 0 };
  for (const monitor of active) counts[monitor.state]++;
  const failedServices = services?.units.filter((unit) => unit.active === "failed").length ?? 0;
  const changingServices =
    services?.units.filter((unit) => unit.active === "activating" || unit.active === "deactivating")
      .length ?? 0;
  const overdue = active.some(
    (monitor) =>
      monitor.checkedAt === null ||
      now - monitor.checkedAt > monitor.intervalSeconds * 1000 + monitor.timeoutMs + 30000,
  );
  const limited =
    stale ||
    !info ||
    info.source !== "host" ||
    now - info.collectedAt > 60000 ||
    !services ||
    services.source !== "host" ||
    !monitors ||
    !active.length ||
    overdue ||
    counts.blocked > 0 ||
    counts.pending > 0 ||
    counts.paused > 0;
  let state: Health = "unknown";
  if (stale) state = "unknown";
  else if (counts.down || (services?.source === "host" && failedServices)) state = "down";
  else if (counts.blocked || (services?.source === "host" && changingServices)) state = "degraded";
  else if (!limited) state = "up";
  return { state, limited, counts, endpoints: active.length, failedServices, changingServices };
}

export type Incident = {
  at: number;
  kind: "failure" | "blocked" | "success";
  check: NetMonitorCheck;
  partialStart: boolean;
};
/** Actual observed check transitions. They do not reconstruct unknown earlier service history. */
export function incidentTimeline(checks: readonly NetMonitorCheck[]): Incident[] {
  const chronological = checks.toSorted((a, b) => a.at - b.at);
  const result: Incident[] = [];
  let previous: "failure" | "blocked" | "success" = "success";
  for (let index = 0; index < chronological.length; index++) {
    const check = chronological[index]!;
    const kind = check.ok ? "success" : check.error === "blocked" ? "blocked" : "failure";
    if (kind !== previous)
      result.push({ at: check.at, kind, check, partialStart: index === 0 && kind !== "success" });
    previous = kind;
  }
  return result.reverse().slice(0, 100);
}

export function durationParts(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}
