/**
 * The small part of Semantic Versioning that manifests use: `MAJOR.MINOR.PATCH` with an optional
 * pre-release (`1.2.0-beta.1`), and ranges `*`, `1.2.3`, `^1.2.3`, `~1.2.3` and `>=1.2.3`.
 */
export const SEMVER_PATTERN =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const RANGE_PATTERN =
  /^(?:\*|(?:\^|~|>=)?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]+)?)$/;

/** The bridge protocol this EveryOS speaks; apps declare the SDK range they were built for. */
export const APP_SDK_VERSION = "1.0.3";

interface Parsed {
  core: [number, number, number];
  pre: string[];
}

function parse(version: string): Parsed {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new Error(`Invalid version: ${version}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && SEMVER_PATTERN.test(value);
}

export function isVersionRange(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && RANGE_PATTERN.test(value);
}

function comparePre(a: string[], b: string[]): number {
  // A release sorts after its pre-releases.
  if (!a.length || !b.length) return a.length ? -1 : b.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const numeric = /^\d+$/.test(left) && /^\d+$/.test(right);
    const result = numeric
      ? Number(left) - Number(right)
      : /^\d+$/.test(left)
        ? -1
        : /^\d+$/.test(right)
          ? 1
          : left < right
            ? -1
            : left > right
              ? 1
              : 0;
    if (result) return Math.sign(result);
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const result = left.core[i]! - right.core[i]!;
    if (result) return Math.sign(result);
  }
  return comparePre(left.pre, right.pre);
}

/** Whether `version` satisfies `range`; pre-releases only satisfy ranges that name one. */
export function satisfies(version: string, range: string): boolean {
  if (range.length > 64 || !RANGE_PATTERN.test(range))
    throw new Error(`Invalid version range: ${range}`);
  const target = parse(version);
  if (range === "*") return target.pre.length === 0;
  const operator = range.startsWith(">=")
    ? ">="
    : range.startsWith("^")
      ? "^"
      : range.startsWith("~")
        ? "~"
        : "=";
  const base = range.slice(operator === "=" ? 0 : operator.length);
  const floor = parse(base);
  if (target.pre.length && !floor.pre.length) return false;
  if (compareVersions(version, base) < 0) return false;
  const [major, minor] = floor.core;
  switch (operator) {
    case "=":
      return compareVersions(version, base) === 0;
    case ">=":
      return true;
    case "~":
      return target.core[0] === major && target.core[1] === minor;
    case "^":
      // ^0.x is minor-compatible only, as in npm.
      return major === 0
        ? target.core[0] === 0 && target.core[1] === minor
        : target.core[0] === major;
  }
}
