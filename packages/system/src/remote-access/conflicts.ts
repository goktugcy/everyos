import { isIP } from "node:net";
import type { RemoteAccessConflict, RemoteAccessNode } from "@everyos/shared";

function network(value: string): { family: number; start: bigint; end: bigint } | null {
  const [ip, prefixText, extra] = value.split("/");
  const family = ip && !ip.includes("%") && isIP(ip),
    prefix = Number(prefixText);
  if (
    !family ||
    extra !== undefined ||
    prefixText === undefined ||
    !/^\d+$/.test(prefixText) ||
    prefix < 0 ||
    prefix > (family === 4 ? 32 : 128)
  )
    return null;
  let parts: bigint[];
  if (family === 4) parts = ip.split(".").map((v) => BigInt(v));
  else {
    let expanded = ip;
    if (expanded.includes(".")) {
      const split = expanded.lastIndexOf(":"),
        bytes = expanded
          .slice(split + 1)
          .split(".")
          .map(Number);
      expanded =
        expanded.slice(0, split + 1) +
        ((bytes[0]! << 8) | bytes[1]!).toString(16) +
        ":" +
        ((bytes[2]! << 8) | bytes[3]!).toString(16);
    }
    const halves = expanded.split("::"),
      left = halves[0] ? halves[0].split(":") : [],
      right = halves[1] ? halves[1].split(":") : [];
    parts = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right].map(
      (v) => BigInt("0x" + v),
    );
  }
  const bits = BigInt(family === 4 ? 8 : 16),
    total = BigInt(family === 4 ? 32 : 128);
  const number = parts.reduce((n, v) => (n << bits) | v, 0n),
    hostBits = total - BigInt(prefix);
  const start = (number >> hostBits) << hostBits;
  return { family, start, end: start + (1n << hostBits) - 1n };
}
export function remoteRoutesOverlap(a: string, b: string): boolean {
  const first = network(a),
    second = network(b);
  return Boolean(
    first &&
    second &&
    first.family === second.family &&
    first.start <= second.end &&
    second.start <= first.end,
  );
}
/** Warnings describe observed or potential interactions; they never turn another VPN off. */
export function remoteAccessConflicts(nodes: readonly RemoteAccessNode[]): RemoteAccessConflict[] {
  const active = nodes.filter((node) => node.state === "connected" && node.available),
    conflicts: RemoteAccessConflict[] = [];
  for (let i = 0; i < active.length; i++)
    for (const other of active.slice(i + 1)) {
      const node = active[i]!,
        providers = [node.provider, other.provider];
      conflicts.push({ kind: "multiple-active", severity: "info", providers, routes: [] });
      if (node.dnsEnabled === true && other.dnsEnabled === true)
        conflicts.push({ kind: "dns", severity: "warning", providers, routes: [] });
      if (node.defaultRoute === true && other.defaultRoute === true)
        conflicts.push({ kind: "exit-node", severity: "critical", providers, routes: [] });
      if (
        !node.routeVisibility ||
        !other.routeVisibility ||
        node.dnsEnabled === null ||
        other.dnsEnabled === null
      )
        conflicts.push({ kind: "visibility", severity: "info", providers, routes: [] });
      const overlaps = new Set<string>();
      for (const first of node.routes)
        for (const second of other.routes)
          if (
            !first.endsWith("/0") &&
            !second.endsWith("/0") &&
            remoteRoutesOverlap(first, second)
          ) {
            overlaps.add(first);
            overlaps.add(second);
          }
      if (overlaps.size)
        conflicts.push({
          kind: "subnet",
          severity: "warning",
          providers,
          routes: [...overlaps].slice(0, 32),
        });
      else if (node.acceptsRoutes && other.acceptsRoutes)
        conflicts.push({ kind: "route-policy", severity: "warning", providers, routes: [] });
    }
  return conflicts;
}
