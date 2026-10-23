import type { DiskUsage, SystemDataSource, SystemStorage } from "@everyos/app-sdk";

export const MAX_SCOPES = 8;
export const MAX_SAMPLES = 24;
export const HISTORY_BYTES = 160 * 1024;
export const PAGE_SIZE = 100;
export type Settings = { rootId: string; path: string; tab: "folder" | "volumes" };
export const DEFAULT_SETTINGS: Settings = { rootId: "", path: "", tab: "folder" };
export type Sample = { at: number; bytes: number };
export type Trend = { key: string; source: SystemDataSource; samples: Sample[] };
export type FolderScan = {
  rootId: string;
  name: string;
  path: string;
  startedAt: number;
  at: number;
  value: DiskUsage;
};
export type StorageScan = { at: number; value: SystemStorage };

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const validNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const validTime = (v: unknown): v is number =>
  validNumber(v) && Number.isSafeInteger(v) && v <= 8.64e15;
export const safePath = (path: string) =>
  path.length <= 4096 &&
  !Array.from(path).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  ) &&
  (path === "" || path.split("/").every((part) => part !== "" && part !== "." && part !== ".."));

export function readSettings(raw: unknown): Settings {
  if (!object(raw)) return DEFAULT_SETTINGS;
  return {
    rootId: typeof raw.rootId === "string" && raw.rootId.length <= 64 ? raw.rootId : "",
    path: typeof raw.path === "string" && safePath(raw.path) ? raw.path : "",
    tab: raw.tab === "volumes" ? "volumes" : "folder",
  };
}

export function childPath(path: string, name: string): string | null {
  if (!name || name.includes("/")) return null;
  const next = path ? `${path}/${name}` : name;
  return safePath(next) ? next : null;
}

export function parentPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

export const folderKey = (rootId: string, path: string) => JSON.stringify(["folder", rootId, path]);
export const mountKey = (device: string, path: string) => JSON.stringify(["mount", device, path]);
const byteSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function boundHistory(history: Trend[]): Trend[] {
  const next = history
    .sort((a, b) => b.samples.at(-1)!.at - a.samples.at(-1)!.at)
    .slice(0, MAX_SCOPES);
  while (next.length && byteSize(next) > HISTORY_BYTES) next.pop();
  return next;
}

export function readHistory(raw: unknown): Trend[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: Trend[] = [];
  for (const entry of raw.slice(0, MAX_SCOPES)) {
    if (
      !object(entry) ||
      typeof entry.key !== "string" ||
      entry.key.length > 8300 ||
      (entry.source !== "host" && entry.source !== "simulated") ||
      !Array.isArray(entry.samples) ||
      seen.has(entry.key)
    )
      continue;
    let previous = -1;
    const samples: Sample[] = [];
    for (const value of entry.samples.slice(-MAX_SAMPLES)) {
      if (
        !object(value) ||
        !validTime(value.at) ||
        !validNumber(value.bytes) ||
        value.at <= previous
      )
        continue;
      previous = value.at;
      samples.push({ at: value.at, bytes: value.bytes });
    }
    if (!samples.length) continue;
    seen.add(entry.key);
    result.push({ key: entry.key, source: entry.source, samples });
  }
  return boundHistory(result);
}

export function recordSample(
  history: Trend[],
  key: string,
  source: SystemDataSource,
  sample: Sample,
): Trend[] {
  if (!validTime(sample.at) || !validNumber(sample.bytes)) return history;
  const previous = history.find((entry) => entry.key === key && entry.source === source);
  const samples = previous ? [...previous.samples] : [];
  const last = samples.at(-1);
  if (last && sample.at <= last.at) return history;
  // Rapid refreshes replace one observation instead of manufacturing a dense trend.
  if (last && sample.at - last.at < 15000) samples.pop();
  samples.push(sample);
  return boundHistory([
    { key, source, samples: samples.slice(-MAX_SAMPLES) },
    ...history.filter((entry) => entry.key !== key),
  ]);
}

export function trendPoints(samples: readonly Sample[]): string {
  if (samples.length < 2) return "";
  const first = samples[0]!.at;
  const duration = samples.at(-1)!.at - first;
  if (duration <= 0) return "";
  const min = Math.min(...samples.map((s) => s.bytes));
  const max = Math.max(...samples.map((s) => s.bytes));
  return samples
    .map(
      (s) =>
        `${(8 + ((s.at - first) / duration) * 584).toFixed(2)},${(max === min ? 60 : 112 - ((s.bytes - min) / (max - min)) * 104).toFixed(2)}`,
    )
    .join(" ");
}

export const usedPercent = (used: number, total: number) =>
  total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;

export function diskReport(
  folder: FolderScan | null,
  storage: StorageScan | null,
  history: Trend[],
  at: number,
) {
  const keys = new Set([
    ...(folder ? [folderKey(folder.rootId, folder.path)] : []),
    ...(storage?.value.mounts.map((mount) => mountKey(mount.device, mount.mountpoint)) ?? []),
  ]);
  return {
    schemaVersion: 1,
    exportedAt: new Date(at).toISOString(),
    folder: folder
      ? {
          name: folder.name,
          path: folder.path,
          source: "host",
          startedAt: folder.startedAt,
          measuredAt: folder.at,
          ...folder.value,
        }
      : null,
    storage,
    history: history
      .filter(
        (trend) =>
          keys.has(trend.key) &&
          (folder && trend.key === folderKey(folder.rootId, folder.path)
            ? trend.source === "host"
            : trend.source === storage?.value.source),
      )
      .map(({ key, ...trend }) => {
        const mount = storage?.value.mounts.find(
          (value) => mountKey(value.device, value.mountpoint) === key,
        );
        return {
          scope: mount
            ? { kind: "mount", device: mount.device, mountpoint: mount.mountpoint }
            : { kind: "folder", name: folder?.name, path: folder?.path },
          ...trend,
        };
      }),
  };
}
