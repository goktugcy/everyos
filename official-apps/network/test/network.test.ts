import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, diagnosticReport, probeUrl, readSettings } from "../src/network.ts";
import { metrics, network, response } from "./fixture.ts";

describe("network diagnostics", () => {
  it("normalizes approved HTTP request URLs and IDNA names", () => {
    expect(probeUrl(" https://bücher.de/status ")).toBe("https://xn--bcher-kva.de/status");
    expect(probeUrl("http://[::1]:8080/")).toBe("http://[::1]:8080/");
  });
  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@service.test",
    "https://service.test/#fragment",
    "not a URL",
    "https://service.test/" + "a".repeat(2048),
  ])("refuses unsafe URL %s", (url) => {
    expect(probeUrl(url)).toBeNull();
  });
  it("validates persisted settings without enabling polling from truthy malformed values", () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings({ url: 7, auto: "true" })).toEqual(DEFAULT_SETTINGS);
    expect(readSettings({ url: "x".repeat(2049), auto: false })).toEqual(DEFAULT_SETTINGS);
    expect(readSettings({ url: "https://service.test/", auto: true, extra: true })).toEqual({
      url: "https://service.test/",
      auto: true,
      interfaceName: "",
    });
  });
  it("keeps raw data sources, timestamps, partial failures and request identity while excluding response secrets", () => {
    const report = diagnosticReport(
      {
        network: { value: network, retrievedAt: 1000 },
        metrics: { value: { ...metrics, source: "simulated" }, retrievedAt: 2000 },
        networkError: null,
        metricsError: "AGENT_UNAVAILABLE",
        probe: { target: "https://service.test/", at: 3000, reply: response },
        attempt: { target: "https://service.test/", at: 2500 },
        probeError: null,
      },
      4000,
    );
    expect(report.network?.value).toEqual(network);
    expect(report.metrics?.value.source).toBe("simulated");
    expect(report.metricsError).toBe("AGENT_UNAVAILABLE");
    expect(report.probe?.response).toMatchObject({
      status: 404,
      timing: { total: 5 },
      remoteAddress: "192.0.2.15",
    });
    expect(report.attempt).toEqual({ target: "https://service.test/", at: 2500 });
    expect(JSON.stringify(report)).not.toContain("endpoint-secret");
    expect(JSON.stringify(report)).not.toContain("private response");
    expect(report.metrics?.value).not.toHaveProperty("disks");
    expect(report.metrics?.value).not.toHaveProperty("point");
    expect(report.generatedAt).toBe(4000);
  });
});
