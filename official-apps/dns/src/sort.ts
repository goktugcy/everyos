import type { DnsRecord } from "@everyos/app-sdk";

/** Mail and service records are read by priority; all other answers keep DNS order. */
export function ordered(records: readonly DnsRecord[]): DnsRecord[] {
  return [...records].sort((a, b) =>
    a.type === "MX" && b.type === "MX"
      ? a.priority - b.priority || a.exchange.localeCompare(b.exchange)
      : a.type === "SRV" && b.type === "SRV"
        ? a.priority - b.priority || b.weight - a.weight
        : 0,
  );
}
