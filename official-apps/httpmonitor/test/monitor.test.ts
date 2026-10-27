import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT,
  historyCsv,
  monitorInput,
  parseDraft,
  readDraft,
  toDraft,
} from "../src/monitor.ts";
import { fixture } from "./fixture.ts";

const draft = { ...EMPTY_DRAFT, name: " Service ", url: "https://bücher.de/health" };
describe("HTTP monitor configuration", () => {
  it("normalizes an IDNA URL and name, preserves exact keyword text and round-trips host settings", () => {
    expect(parseDraft({ ...draft, keyword: " ready " })).toEqual({
      input: {
        name: "Service",
        url: "https://xn--bcher-kva.de/health",
        method: "GET",
        intervalSeconds: 60,
        timeoutMs: 10000,
        expectStatus: { min: 200, max: 299 },
        keyword: " ready ",
        downAfter: 1,
        verifyTls: true,
        notify: true,
        enabled: true,
      },
    });
    const monitor = fixture();
    expect(monitorInput(monitor, false)).toEqual({
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      method: monitor.method,
      intervalSeconds: monitor.intervalSeconds,
      timeoutMs: monitor.timeoutMs,
      expectStatus: monitor.expectStatus,
      keyword: monitor.keyword,
      downAfter: monitor.downAfter,
      verifyTls: monitor.verifyTls,
      notify: monitor.notify,
      enabled: false,
    });
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:password@service.test",
    "https://service.test/#part",
    "not a URL",
  ])("refuses unsafe or invalid URLs: %s", (url) => {
    expect(parseDraft({ ...draft, url })).toEqual({ error: "url" });
  });

  it.each([
    [{ name: " " }, "name"],
    [{ name: "a".repeat(81) }, "name"],
    [{ interval: "59" }, "interval"],
    [{ interval: "86401" }, "interval"],
    [{ interval: "60.5" }, "interval"],
    [{ timeout: "999" }, "timeout"],
    [{ timeout: "30001" }, "timeout"],
    [{ min: "99" }, "status"],
    [{ max: "600" }, "status"],
    [{ min: "300", max: "200" }, "status"],
    [{ keyword: "a".repeat(201) }, "keyword"],
    [{ method: "HEAD", keyword: "ready" }, "keyword"],
    [{ downAfter: "0" }, "downAfter"],
    [{ downAfter: "6" }, "downAfter"],
  ] as const)("refuses out of bounds settings %j", (change, error) => {
    expect(parseDraft({ ...draft, ...change })).toEqual({ error });
  });

  it("accepts inclusive limits and HEAD without a body assertion", () => {
    expect(
      parseDraft({
        ...draft,
        interval: "86400",
        timeout: "30000",
        min: "100",
        max: "599",
        downAfter: "5",
        method: "HEAD",
      }),
    ).toMatchObject({
      input: {
        intervalSeconds: 86400,
        timeoutMs: 30000,
        expectStatus: { min: 100, max: 599 },
        downAfter: 5,
        method: "HEAD",
        keyword: null,
      },
    });
  });

  it("recovers incomplete input while rejecting malformed storage and ignoring unexpected keys", () => {
    expect(readDraft({ ...EMPTY_DRAFT, interval: "", name: "unfinished" })).toEqual({
      ...EMPTY_DRAFT,
      interval: "",
      name: "unfinished",
    });
    for (const value of [
      null,
      [],
      5,
      {},
      { ...EMPTY_DRAFT, verifyTls: "true" },
      { ...EMPTY_DRAFT, method: "DELETE" },
      { ...EMPTY_DRAFT, url: "x".repeat(2049) },
    ]) {
      expect(readDraft(value)).toBeNull();
    }
    expect(readDraft({ ...EMPTY_DRAFT, injected: true })).toEqual(EMPTY_DRAFT);
    expect(readDraft(toDraft(fixture()))).toEqual(toDraft(fixture()));
  });
});

describe("monitor CSV export", () => {
  it("quotes commas, quotes and newlines, neutralizes formula input and exports every check chronologically", () => {
    const checks = [
      { at: 2000, ok: false, status: 503, ms: 15, error: "status" },
      { at: 1000, ok: true, status: 200, ms: 10, error: null },
    ];
    const csv = historyCsv(fixture({ name: '=HYPERLINK("x")\n,service' }), checks);
    expect(csv).toContain('"\'=HYPERLINK(""x"")\n,service"');
    expect(csv.indexOf("1970-01-01T00:00:01.000Z")).toBeLessThan(
      csv.indexOf("1970-01-01T00:00:02.000Z"),
    );
    expect(csv).toContain('"false","503","15","status"\r\n');
    expect(checks[0]?.at).toBe(2000);
  });
});
