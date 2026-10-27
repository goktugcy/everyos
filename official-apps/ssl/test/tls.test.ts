import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT,
  endpointKey,
  endpointLabel,
  MAX_ENDPOINTS,
  parseEndpoint,
  readDraft,
  readEndpoints,
  tlsInput,
  validity,
} from "../src/tls.ts";

describe("TLS endpoints", () => {
  it.each([
    [" Example.COM. ", "example.com"],
    ["bücher.de", "xn--bcher-kva.de"],
    ["127.0.0.1", "127.0.0.1"],
    ["2001:db8::1", "2001:db8::1"],
    ["[::1]", "::1"],
  ])("normalizes %s", (input, host) => {
    expect(parseEndpoint({ host: input, port: "8443", servername: "bücher.de" })).toEqual({
      host,
      port: 8443,
      servername: "xn--bcher-kva.de",
    });
  });
  it.each([
    "",
    "http://test",
    "test:443",
    "[::1]:443",
    "a/b",
    "a@b",
    "a?b",
    "a#b",
    "a%2eb",
    "a_b.test",
    "a..test",
    "a-.test",
    "-a.test",
    "127.1",
    "256.1.1.1",
    "::1%lo0",
    "a b",
    "a\\b",
    "single-label",
  ])("refuses host %s", (host) => {
    expect(parseEndpoint({ host, port: "443", servername: "" })).toBeNull();
  });
  it("rejects ambiguous ports and non-DNS SNI values", () => {
    for (const port of ["", "0", "65536", "1e3", "1.5", "-1"])
      expect(parseEndpoint({ host: "test", port, servername: "" })).toBeNull();
    for (const servername of ["127.0.0.1", "::1", "a/b", "test:443"])
      expect(parseEndpoint({ host: "test", port: "443", servername })).toBeNull();
    expect(parseEndpoint({ host: "a".repeat(64), port: "443", servername: "" })).toBeNull();
  });
  it("validates persisted values, deduplicates and bounds saved endpoints", () => {
    const endpoint = { host: "example.test", port: 443, servername: null };
    expect(readDraft({ port: 123, host: [], servername: {} })).toEqual(EMPTY_DRAFT);
    expect(readEndpoints(null)).toEqual([]);
    expect(
      readEndpoints([
        null,
        {},
        endpoint,
        endpoint,
        { ...endpoint, host: "bad/path" },
        { ...endpoint, port: 0 },
      ]),
    ).toEqual([endpoint]);
    expect(
      readEndpoints(Array.from({ length: 80 }, (_, i) => ({ ...endpoint, host: `host${i}.test` }))),
    ).toHaveLength(MAX_ENDPOINTS);
    expect(endpointKey(endpoint)).not.toBe(endpointKey({ ...endpoint, servername: "sni.test" }));
    expect(endpointLabel({ ...endpoint, host: "::1" })).toBe("[::1]:443");
    expect(tlsInput(endpoint)).toEqual({ ...endpoint, timeoutMs: 10000 });
  });
});

describe("certificate validity", () => {
  const now = Date.UTC(2026, 9, 22);
  const day = 86400000;
  it("distinguishes expired, future, expiring and currently valid certificates at exact boundaries", () => {
    expect(validity({ validFrom: now - day, validTo: now }, now)).toBe("expired");
    expect(validity({ validFrom: now + 1, validTo: now + 60 * day }, now)).toBe("future");
    expect(validity({ validFrom: now, validTo: now + 30 * day }, now)).toBe("soon");
    expect(validity({ validFrom: now, validTo: now + 30 * day + 1 }, now)).toBe("valid");
  });
});
