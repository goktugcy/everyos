import type { Json, PathSegment } from "./json.ts";

export interface Difference {
  path: PathSegment[];
  kind: "added" | "removed" | "changed";
  before?: Json;
  after?: Json;
}

const isObject = (value: Json): value is { [key: string]: Json } =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** What changed from `before` to `after`: members and elements compared by key and position. */
export function diffJson(
  before: Json,
  after: Json,
  path: PathSegment[] = [],
  out: Difference[] = [],
): Difference[] {
  if (isObject(before) && isObject(after)) {
    for (const key of Object.keys(before))
      if (!(key in after))
        out.push({ path: [...path, key], kind: "removed", before: before[key]! });
      else diffJson(before[key]!, after[key]!, [...path, key], out);
    for (const key of Object.keys(after))
      if (!(key in before)) out.push({ path: [...path, key], kind: "added", after: after[key]! });
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const shared = Math.min(before.length, after.length);
    for (let index = 0; index < shared; index += 1)
      diffJson(before[index]!, after[index]!, [...path, index], out);
    for (let index = shared; index < before.length; index += 1)
      out.push({ path: [...path, index], kind: "removed", before: before[index]! });
    for (let index = shared; index < after.length; index += 1)
      out.push({ path: [...path, index], kind: "added", after: after[index]! });
    return out;
  }
  if (JSON.stringify(before) !== JSON.stringify(after))
    out.push({ path, kind: "changed", before, after });
  return out;
}
