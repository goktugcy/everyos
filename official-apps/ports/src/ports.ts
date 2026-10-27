import type { SystemSockets } from "@everyos/app-sdk";

export type Listener = SystemSockets["listening"][number];
export interface Filters {
  query: string;
  protocol: "all" | "tcp" | "udp";
  family: "all" | "ipv4" | "ipv6";
  scope: "all" | "wildcard" | "loopback" | "specific";
}
export const DEFAULT_FILTERS: Filters = { query: "", protocol: "all", family: "all", scope: "all" };

export function readFilters(value: unknown): Filters {
  if (!value || typeof value !== "object") return DEFAULT_FILTERS;
  const v = value as Record<string, unknown>;
  return {
    query: typeof v.query === "string" ? v.query.slice(0, 200) : "",
    protocol: v.protocol === "tcp" || v.protocol === "udp" ? v.protocol : "all",
    family: v.family === "ipv4" || v.family === "ipv6" ? v.family : "all",
    scope:
      v.scope === "wildcard" || v.scope === "loopback" || v.scope === "specific" ? v.scope : "all",
  };
}

/** Bind scope does not imply reachability: routing and firewalls are independent. */
export function bindScope(address: string): Exclude<Filters["scope"], "all"> {
  if (address === "0.0.0.0" || address === "::") return "wildcard";
  if (
    address === "::1" ||
    /^127\./.test(address) ||
    /^::ffff:(?:127\.|7f[\da-f]{2}:)/i.test(address)
  )
    return "loopback";
  return "specific";
}

export function endpoint(listener: Listener): string {
  return `${listener.address.includes(":") ? `[${listener.address}]` : listener.address}:${listener.port}`;
}

export function filterListeners(listeners: readonly Listener[], filters: Filters): Listener[] {
  const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return listeners
    .filter((row) => {
      if (filters.protocol !== "all" && filters.protocol !== row.protocol) return false;
      if (
        filters.family !== "all" &&
        (row.address.includes(":") ? "ipv6" : "ipv4") !== filters.family
      )
        return false;
      if (filters.scope !== "all" && bindScope(row.address) !== filters.scope) return false;
      const text =
        `${row.protocol} ${row.address} ${row.port} ${row.process ?? ""} ${endpoint(row)}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .toSorted(
      (a, b) =>
        a.port - b.port ||
        a.protocol.localeCompare(b.protocol) ||
        a.address.localeCompare(b.address),
    );
}

export function listenersCsv(
  source: SystemSockets["source"],
  at: number,
  listeners: readonly Listener[],
): string {
  const cell = (value: string | number | null) => {
    let text = value === null ? "" : String(value);
    if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows: (string | number | null)[][] = [
    ["source", "retrieved_at_utc", "protocol", "address", "port", "process", "bind_scope"],
    ...listeners.map((row) => [
      source,
      new Date(at).toISOString(),
      row.protocol,
      row.address,
      row.port,
      row.process,
      bindScope(row.address),
    ]),
  ];
  return `${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
