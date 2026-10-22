import type { DnsRecord, NetDnsResult } from "@everyos/app-sdk";
import { describe, expect, it } from "vitest";
import {
  addHistory,
  COMMON_TYPES,
  DEFAULT_SETTINGS,
  isIp,
  MAX_HISTORY,
  normalizeName,
  readHistory,
  readSettings,
  recordValue,
  txtKind,
  zoneLines,
  type HistoryEntry,
} from "../src/dns.ts";
import { ordered } from "../src/sort.ts";

describe("DNS names", () => {
  it.each([
    ["  Example.COM. ", "example.com"],
    ["bücher.de", "xn--bcher-kva.de"],
    ["_sip._tcp.bücher.de", "_sip._tcp.xn--bcher-kva.de"],
    ["selector._domainkey.example.com", "selector._domainkey.example.com"],
    ["_dmarc.example.com", "_dmarc.example.com"],
  ])("normalizes %s without moving service labels", (input, name) => {
    expect(normalizeName(input, "TXT")).toEqual({ name });
  });
  it.each([
    "https://example.com",
    "example.com:53",
    "a/b",
    "a?b",
    "user@host",
    "a#b",
    "a%2eb",
    "a..b",
    "-a.test",
    "a-.test",
    "a_b.test",
    "a b",
    "127.1",
    "a\\b",
    "[::1]",
  ])("refuses %s", (input) => {
    expect(normalizeName(input, "A")).toEqual({ problem: "invalid" });
  });
  it("enforces name and label limits and treats IPs as reverse lookups", () => {
    expect(normalizeName(" ", "A")).toEqual({ problem: "empty" });
    expect(normalizeName(`${"a".repeat(64)}.test`, "A")).toEqual({ problem: "invalid" });
    expect(normalizeName(Array(5).fill("a".repeat(63)).join("."), "A")).toEqual({
      problem: "tooLong",
    });
    for (const address of ["192.0.2.1", "2001:db8::1"]) {
      expect(isIp(address)).toBe(true);
      expect(normalizeName(address, "PTR")).toEqual({ name: address });
      expect(normalizeName(address, "A")).toEqual({ problem: "needsAddress" });
    }
    for (const address of ["1.2.3", "256.1.1.1", "example.com", "::ffff:999.1.1.1", "::1%lo0"])
      expect(isIp(address)).toBe(false);
  });
});

describe("DNS answers", () => {
  it("formats all record variants and escapes quotes and backslashes exactly once", () => {
    const records: DnsRecord[] = [
      { type: "A", address: "192.0.2.1", ttl: 60 },
      { type: "AAAA", address: "2001:db8::1", ttl: 120 },
      { type: "CNAME", value: "target.test." },
      { type: "NS", value: "ns.test" },
      { type: "PTR", value: "reverse.test" },
      { type: "MX", exchange: "mail.test", priority: 10 },
      { type: "TXT", text: 'a"b\\c' },
      { type: "CAA", critical: 0, tag: "issue", value: 'ca".test' },
      { type: "SRV", target: "sip.test", port: 5060, priority: 10, weight: 20 },
      {
        type: "SOA",
        nsname: "ns.test",
        hostmaster: "admin.test",
        serial: 1,
        refresh: 2,
        retry: 3,
        expire: 4,
        minttl: 5,
      },
    ];
    expect(records.map(recordValue)).toEqual([
      "192.0.2.1",
      "2001:db8::1",
      "target.test.",
      "ns.test.",
      "reverse.test.",
      "10 mail.test.",
      '"a\\"b\\\\c"',
      '0 issue "ca\\".test"',
      "10 20 5060 sip.test.",
      "ns.test. admin.test. 1 2 3 4 5",
    ]);
    const result: NetDnsResult = {
      name: "example.test",
      type: "A",
      status: "ok",
      servers: [],
      ms: 1,
      records: records.slice(0, 1),
    };
    expect(zoneLines(result)).toEqual(["example.test.\t60\tIN\tA\t192.0.2.1"]);
    expect(txtKind("example.test", "v=spf1 -all")).toBe("spf");
    expect(txtKind("_dmarc.example.test", "policy")).toBe("dmarc");
    expect(txtKind("selector._domainkey.example.test", "key")).toBe("dkim");
    expect(txtKind("example.test", "google-site-verification=value")).toBe("verification");
    expect(txtKind("example.test", "plain text")).toBeNull();
  });
  it("orders mail and service records without changing the original answer", () => {
    const records: DnsRecord[] = [
      { type: "MX", exchange: "b.test", priority: 20 },
      { type: "MX", exchange: "a.test", priority: 10 },
    ];
    expect(ordered(records)).toEqual([records[1], records[0]]);
    expect(records[0]).toMatchObject({ priority: 20 });
  });
});

describe("DNS persistence", () => {
  const entry: HistoryEntry = {
    name: "example.test",
    types: [...COMMON_TYPES],
    server: null,
    port: 53,
    at: 1,
  };
  it("validates stored settings and history instead of trusting storage", () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings({ type: "INVALID", server: {}, name: [], custom: 2, port: -1 })).toEqual(
      DEFAULT_SETTINGS,
    );
    expect(
      readSettings({
        type: "PTR",
        name: "192.0.2.1",
        server: "custom",
        custom: "::1",
        port: "5353",
      }),
    ).toEqual({ type: "PTR", name: "192.0.2.1", server: "custom", custom: "::1", port: "5353" });
    expect(
      readHistory([
        entry,
        {},
        null,
        { ...entry, at: Infinity },
        { ...entry, at: 9e15 },
        { ...entry, types: ["INVALID"] },
        { ...entry, server: "example.com" },
        { ...entry, port: 65536 },
        { ...entry, name: "bad/path" },
      ]),
    ).toEqual([entry]);
    expect(readHistory("bad")).toEqual([]);
  });
  it("deduplicates targets including resolver ports and bounds history", () => {
    const many = Array.from({ length: MAX_HISTORY }, (_, i) => ({
      ...entry,
      name: `host${i}.test`,
    }));
    expect(addHistory(many, entry)).toHaveLength(MAX_HISTORY);
    expect(addHistory([entry], { ...entry, at: 2 })).toEqual([{ ...entry, at: 2 }]);
    expect(addHistory([entry], { ...entry, port: 5353 })).toHaveLength(2);
    expect(readHistory(Array(100).fill(entry))).toHaveLength(MAX_HISTORY);
  });
});
