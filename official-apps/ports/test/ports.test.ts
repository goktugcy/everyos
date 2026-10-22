import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  bindScope,
  endpoint,
  filterListeners,
  listenersCsv,
  readFilters,
  type Listener,
} from "../src/ports.ts";

export const listeners: Listener[] = [
  { protocol: "tcp", address: "0.0.0.0", port: 443, process: "nginx" },
  { protocol: "udp", address: "127.0.0.1", port: 53, process: "resolver" },
  { protocol: "tcp", address: "::1", port: 8080, process: null },
  { protocol: "udp", address: "192.168.1.20", port: 5353, process: "mDNS" },
];

describe("port inspection helpers", () => {
  it("combines query terms and filters without mutating the input, ordered by port", () => {
    expect(filterListeners(listeners, DEFAULT_FILTERS).map((row) => row.port)).toEqual([
      53, 443, 5353, 8080,
    ]);
    expect(filterListeners(listeners, { ...DEFAULT_FILTERS, query: "TCP NGINX" })).toEqual([
      listeners[0],
    ]);
    expect(
      filterListeners(listeners, { ...DEFAULT_FILTERS, protocol: "udp", scope: "loopback" }),
    ).toEqual([listeners[1]]);
    expect(
      filterListeners(listeners, { ...DEFAULT_FILTERS, family: "ipv6", query: "[::1]:8080" }),
    ).toEqual([listeners[2]]);
    expect(
      filterListeners(listeners, { ...DEFAULT_FILTERS, family: "ipv4", scope: "specific" }),
    ).toEqual([listeners[3]]);
    expect(filterListeners(listeners, { ...DEFAULT_FILTERS, query: "nginx 53" })).toEqual([]);
    expect(listeners[0]?.port).toBe(443);
  });
  it.each([
    ["0.0.0.0", "wildcard"],
    ["::", "wildcard"],
    ["127.42.0.5", "loopback"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["192.168.1.20", "specific"],
    ["2001:db8::1", "specific"],
  ] as const)("describes binding %s without guessing network reachability", (address, scope) => {
    expect(bindScope(address)).toBe(scope);
  });
  it("reads bounded, validated filters from untrusted storage", () => {
    expect(readFilters(null)).toEqual(DEFAULT_FILTERS);
    expect(readFilters({ query: 7, protocol: "icmp", family: "other", scope: "public" })).toEqual(
      DEFAULT_FILTERS,
    );
    expect(
      readFilters({ query: "x".repeat(300), protocol: "tcp", family: "ipv6", scope: "loopback" }),
    ).toEqual({ query: "x".repeat(200), protocol: "tcp", family: "ipv6", scope: "loopback" });
  });
  it("formats bracketed IPv6 endpoints and exports source metadata and safe text cells", () => {
    expect(endpoint(listeners[2]!)).toBe("[::1]:8080");
    const csv = listenersCsv("simulated", 1700000000000, [
      { ...listeners[0]!, process: '=run("a,b")\nnext' },
      listeners[2]!,
    ]);
    expect(csv).toContain('"simulated","2023-11-14T22:13:20.000Z","tcp"');
    expect(csv).toContain('"\'=run(""a,b"")\nnext"');
    expect(csv).toContain('"::1","8080","","loopback"\r\n');
  });
});
