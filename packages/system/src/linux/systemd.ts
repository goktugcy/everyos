import type { ServiceDetail } from "@otuken/shared";

/*
 * Parsers for `systemctl` machine-readable output (systemd ≥ 248):
 *   systemctl list-units --type=service --all --output=json
 *   systemctl list-unit-files --type=service --output=json
 *   systemctl show --timestamp=unix <unit>
 */

export interface ListedUnit {
  name: string;
  description: string;
  load: string;
  active: string;
  sub: string;
}

const str = (value: unknown, max = 512): string =>
  typeof value === "string" ? value.slice(0, max) : "";

export function parseListUnits(json: unknown): ListedUnit[] {
  if (!Array.isArray(json)) return [];
  return json
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map((row) => ({
      name: str(row.unit, 256),
      description: str(row.description),
      load: str(row.load, 64),
      active: str(row.active, 64),
      sub: str(row.sub, 64),
    }))
    .filter((unit) => unit.name.length > 0);
}

/** unit file name → enablement state ("enabled", "disabled", "static", "masked", …). */
export function parseListUnitFiles(json: unknown): Map<string, string> {
  const states = new Map<string, string>();
  if (!Array.isArray(json)) return states;
  for (const row of json) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const name = str(record.unit_file, 256);
    if (name) states.set(name, str(record.state, 64));
  }
  return states;
}

/** `systemctl show` KEY=VALUE output. */
export function parseShow(text: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return props;
}

const UNSET = new Set(["", "[not set]", "infinity", "18446744073709551615"]);

function numberProp(props: Map<string, string>, key: string): number | null {
  const value = props.get(key);
  if (value === undefined || UNSET.has(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** "@1700000000" (from --timestamp=unix) → epoch milliseconds. */
function unixTimestampProp(props: Map<string, string>, key: string): number | null {
  const match = /^@(\d+)$/.exec(props.get(key) ?? "");
  return match ? Number(match[1]) * 1000 : null;
}

export function serviceDetailFromShow(
  props: Map<string, string>,
  isProtected: boolean,
): Omit<ServiceDetail, "source"> {
  const text = (key: string, max = 512) => {
    const value = props.get(key);
    return value === undefined || value === "" ? null : value.slice(0, max);
  };
  const mainPid = numberProp(props, "MainPID");
  return {
    name: text("Id", 256) ?? "",
    description: text("Description") ?? "",
    load: text("LoadState", 64) ?? "",
    active: text("ActiveState", 64) ?? "",
    sub: text("SubState", 64) ?? "",
    unitFileState: text("UnitFileState", 64),
    protected: isProtected,
    mainPid: mainPid && mainPid > 0 ? mainPid : null,
    activeSince: unixTimestampProp(props, "ActiveEnterTimestamp"),
    memoryBytes: numberProp(props, "MemoryCurrent"),
    cpuNanoseconds: numberProp(props, "CPUUsageNSec"),
    tasks: numberProp(props, "TasksCurrent"),
    restarts: numberProp(props, "NRestarts"),
    fragmentPath: text("FragmentPath", 1024),
    restartPolicy: text("Restart", 64),
    type: text("Type", 64),
  };
}

export const SHOW_PROPERTIES = [
  "Id",
  "Description",
  "LoadState",
  "ActiveState",
  "SubState",
  "UnitFileState",
  "MainPID",
  "ActiveEnterTimestamp",
  "MemoryCurrent",
  "CPUUsageNSec",
  "TasksCurrent",
  "NRestarts",
  "FragmentPath",
  "Restart",
  "Type",
] as const;

/** `systemctl list-timers --all --output=json` (timestamps in microseconds; 0/null = never). */
export function parseListTimers(
  raw: unknown,
): Array<{ unit: string; activates: string | null; next: number | null; last: number | null }> {
  if (!Array.isArray(raw)) return [];
  const time = (value: unknown) =>
    typeof value === "number" && value > 0 ? Math.round(value / 1000) : null;
  return raw.slice(0, 500).flatMap((entry: unknown) => {
    const timer = (entry ?? {}) as Record<string, unknown>;
    if (typeof timer.unit !== "string") return [];
    return [
      {
        unit: timer.unit.slice(0, 256),
        activates: typeof timer.activates === "string" ? timer.activates.slice(0, 256) : null,
        next: time(timer.next),
        last: time(timer.last),
      },
    ];
  });
}
