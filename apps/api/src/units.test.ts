import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OTUKEN_VERSION } from "@otuken/shared";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  createProxyMatcher,
  DEFAULT_PORT,
  isExposedBinding,
  loadApiConfig,
} from "./config.ts";
import { normalizeAddress, resolveClientInfo } from "./http/client-info.ts";
import { FailureLimiter } from "./modules/auth/rate-limiter.ts";

describe("API config", () => {
  it("binds to loopback by default in production", () => {
    const config = loadApiConfig({});
    expect(config.mode).toBe("production");
    expect(config.server).toMatchObject({
      host: "127.0.0.1",
      port: DEFAULT_PORT,
      trustedProxies: [],
      tls: null,
    });
    expect(config.paths).toMatchObject({
      dataDir: "/var/lib/otuken",
      databaseFile: "/var/lib/otuken/otuken.db",
      secretKeyFile: "/var/lib/otuken/secret.key",
      agentSocket: "/run/otuken/agent.sock",
      webDir: "/usr/lib/otuken/web",
    });
  });

  it("merges file values and environment overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "otuken-cfg-"));
    const file = join(dir, "config.yaml");
    writeFileSync(
      file,
      [
        "server:",
        "  host: 100.64.0.10",
        "  port: 8443",
        "  trustedProxies: [127.0.0.1, 10.0.0.0/8]",
        "  publicOrigins: ['https://otuken.tail.ts.net']",
        "security:",
        "  sessionIdleMinutes: 30",
        "logging:",
        "  level: warn",
      ].join("\n"),
    );
    const config = loadApiConfig({ OTUKEN_CONFIG: file, OTUKEN_PORT: "9000" });
    expect(config.server).toMatchObject({
      host: "100.64.0.10",
      port: 9000,
      trustedProxies: ["127.0.0.1", "10.0.0.0/8"],
    });
    expect(config.server.publicOrigins).toEqual(["https://otuken.tail.ts.net"]);
    expect(config.security.sessionIdleMs).toBe(30 * 60_000);
    expect(config.logging.level).toBe("warn");
  });

  it("rejects unknown keys and invalid values", () => {
    const dir = mkdtempSync(join(tmpdir(), "otuken-cfg-"));
    const file = join(dir, "config.yaml");
    writeFileSync(file, "server:\n  hots: 0.0.0.0\n");
    expect(() => loadApiConfig({ OTUKEN_CONFIG: file })).toThrow(ConfigError);
    writeFileSync(file, "server:\n  trustedProxies: ['not-an-ip']\n");
    expect(() => loadApiConfig({ OTUKEN_CONFIG: file })).toThrow(/IP address or CIDR/);
    expect(() => loadApiConfig({ OTUKEN_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadApiConfig({ OTUKEN_CONFIG: join(dir, "missing.yaml") })).toThrow(ConfigError);
  });

  it("requires a dev root in development mode", () => {
    expect(() => loadApiConfig({ OTUKEN_ENV: "development" })).toThrow(ConfigError);
  });

  it("detects exposed bindings", () => {
    expect(isExposedBinding("127.0.0.1")).toBe(false);
    expect(isExposedBinding("::1")).toBe(false);
    expect(isExposedBinding("0.0.0.0")).toBe(true);
    expect(isExposedBinding("100.64.0.10")).toBe(true);
  });
});

describe("client info", () => {
  const headers = (values: Record<string, string>) => (name: string) => values[name];
  const trusted = createProxyMatcher(["10.0.0.1", "172.16.0.0/12"]);

  it("normalizes IPv4-mapped IPv6 addresses", () => {
    expect(normalizeAddress("::ffff:192.168.1.5")).toBe("192.168.1.5");
    expect(normalizeAddress(undefined)).toBe("unknown");
  });

  it("ignores forwarded headers from untrusted peers", () => {
    const info = resolveClientInfo(
      { remoteAddress: "192.168.1.5", encrypted: false },
      headers({ host: "pi:7470", "x-forwarded-for": "1.2.3.4", "x-forwarded-proto": "https" }),
      trusted,
    );
    expect(info).toEqual({
      ip: "192.168.1.5",
      secure: false,
      loopback: false,
      host: "pi:7470",
      expectedOrigin: "http://pi:7470",
    });
  });

  it("walks the forwarded chain past trusted proxies", () => {
    const info = resolveClientInfo(
      { remoteAddress: "10.0.0.1", encrypted: false },
      headers({
        host: "internal",
        "x-forwarded-for": "6.6.6.6, 203.0.113.7, 172.16.0.3",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "otuken.example",
      }),
      trusted,
    );
    expect(info).toMatchObject({
      ip: "203.0.113.7",
      secure: true,
      host: "otuken.example",
      expectedOrigin: "https://otuken.example",
    });
  });

  it("drops malformed host headers", () => {
    const info = resolveClientInfo(
      { remoteAddress: "127.0.0.1", encrypted: false },
      headers({ host: "evil.com/<script>" }),
      trusted,
    );
    expect(info.host).toBeNull();
    expect(info.expectedOrigin).toBeNull();
    expect(info.loopback).toBe(true);
  });
});

describe("FailureLimiter", () => {
  it("locks after the threshold with exponential backoff and resets on success", () => {
    let now = 0;
    const limiter = new FailureLimiter({
      maxFailures: 3,
      windowMs: 60_000,
      baseLockMs: 1_000,
      maxLockMs: 3_000,
      now: () => now,
    });
    for (let i = 0; i < 3; i++) limiter.recordFailure("k");
    expect(limiter.check("k")).toEqual({ allowed: false, retryAfterMs: 1_000 });
    now = 1_001;
    expect(limiter.check("k").allowed).toBe(true);
    for (let i = 0; i < 3; i++) limiter.recordFailure("k");
    expect(limiter.check("k")).toEqual({ allowed: false, retryAfterMs: 2_000 });
    now = 10_000;
    for (let i = 0; i < 3; i++) limiter.recordFailure("k");
    expect(limiter.check("k")).toEqual({ allowed: false, retryAfterMs: 3_000 });
    limiter.reset("k");
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("bounds memory use", () => {
    const limiter = new FailureLimiter({
      maxFailures: 5,
      windowMs: 1_000,
      baseLockMs: 1_000,
      maxLockMs: 1_000,
      maxEntries: 100,
    });
    for (let i = 0; i < 1_000; i++) limiter.recordFailure(`ip:${i}`);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });
});

describe("version", () => {
  it("matches the coordinated version in the root package.json", () => {
    const root = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(OTUKEN_VERSION).toBe(root.version);
  });
});
