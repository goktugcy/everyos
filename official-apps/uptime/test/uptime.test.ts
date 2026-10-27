import type { NetMonitorCheck } from "@everyos/app-sdk";
import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT,
  durationParts,
  healthSummary,
  incidentTimeline,
  parseDraft,
  readDraft,
  toDraft,
} from "../src/uptime.ts";
import { info, monitor, services } from "./fixture.ts";

describe("Uptime measurements and endpoint drafts", () => {
  it("counts a successful summary only with complete real, fresh measurements and enabled checked endpoints", () => {
    expect(healthSummary(info(1000), services, [monitor(1000)], false, 1000)).toMatchObject({
      state: "up",
      limited: false,
      endpoints: 1,
      counts: { up: 1 },
    });
    for (const [host, units, endpoints] of [
      [null, services, [monitor(1000)]],
      [info(1000), null, [monitor(1000)]],
      [info(1000), services, null],
      [{ ...info(1000), source: "simulated" as const }, services, [monitor(1000)]],
      [info(1000), { ...services, source: "simulated" as const }, [monitor(1000)]],
    ] as const)
      expect(healthSummary(host, units, endpoints, false, 1000)).toMatchObject({
        state: "unknown",
        limited: true,
      });
    expect(healthSummary(info(1000), services, [], false, 1000).state).toBe("unknown");
    expect(
      healthSummary(
        info(1000),
        services,
        [{ ...monitor(1000), enabled: false, state: "paused" }],
        false,
        1000,
      ).state,
    ).toBe("unknown");
  });
  it("marks old host data, overdue endpoints and failed refreshes as incomplete rather than healthy", () => {
    expect(healthSummary(info(0), services, [monitor(70000)], false, 70000).state).toBe("unknown");
    expect(healthSummary(info(200000), services, [monitor(0)], false, 200000).state).toBe(
      "unknown",
    );
    expect(
      healthSummary(info(1000), services, [{ ...monitor(1000), state: "down" }], true, 1000),
    ).toMatchObject({ state: "unknown", limited: true });
    expect(
      healthSummary(
        info(1000),
        services,
        [{ ...monitor(1000), checkedAt: null, state: "pending" }],
        false,
        1000,
      ).state,
    ).toBe("unknown");
  });
  it("distinguishes real failures, blocked targets and service transitions from simulated failures", () => {
    const failed = {
      ...services,
      units: services.units.map((unit) => ({ ...unit, active: "failed" })),
    };
    expect(healthSummary(info(1000), failed, [monitor(1000)], false, 1000)).toMatchObject({
      state: "down",
      failedServices: 2,
    });
    expect(
      healthSummary(info(1000), { ...failed, source: "simulated" }, [monitor(1000)], false, 1000)
        .state,
    ).toBe("unknown");
    expect(
      healthSummary(null, null, [{ ...monitor(1000), state: "down" }], false, 1000),
    ).toMatchObject({ state: "down", limited: true });
    expect(
      healthSummary(info(1000), services, [{ ...monitor(1000), state: "blocked" }], false, 1000),
    ).toMatchObject({ state: "degraded", limited: true });
    const changing = {
      ...services,
      units: services.units.map((unit) => ({ ...unit, active: "activating" })),
    };
    expect(healthSummary(info(1000), changing, [monitor(1000)], false, 1000).state).toBe(
      "degraded",
    );
  });
  it("records only observed check transitions, preserves partial starts and orders the latest incidents first", () => {
    const check = (at: number, ok: boolean, error: string | null = null): NetMonitorCheck => ({
      at,
      ok,
      error,
      status: ok ? 200 : 503,
      ms: 1,
    });
    const history = [
      check(5, true),
      check(1, false, "status"),
      check(2, false, "status"),
      check(3, false, "blocked"),
      check(4, false, "blocked"),
    ];
    expect(
      incidentTimeline(history).map((value) => [value.at, value.kind, value.partialStart]),
    ).toEqual([
      [5, "success", false],
      [3, "blocked", false],
      [1, "failure", true],
    ]);
    expect(incidentTimeline([check(1, true), check(2, true)])).toEqual([]);
    expect(
      incidentTimeline(Array.from({ length: 200 }, (_, i) => check(i, i % 2 === 0))),
    ).toHaveLength(100);
    expect(incidentTimeline([])).toEqual([]);
  });
  it("builds bounded GET checks with verified TLS and explicit health expectations", () => {
    expect(parseDraft({ ...EMPTY_DRAFT, name: " Home ", url: "https://home.test" })).toEqual({
      input: {
        name: "Home",
        url: "https://home.test/",
        method: "GET",
        intervalSeconds: 60,
        timeoutMs: 10000,
        expectStatus: { min: 200, max: 299 },
        downAfter: 1,
        keyword: null,
        verifyTls: true,
        notify: true,
        enabled: true,
      },
    });
    const existing = monitor();
    expect(parseDraft(toDraft(existing))).toMatchObject({
      input: { id: existing.id, url: existing.url },
    });
  });
  it("rejects credentials, unsafe schemes, fragments and invalid numeric bounds before a host call", () => {
    const good = { ...EMPTY_DRAFT, name: "Home", url: "https://home.test/" };
    for (const url of [
      "file:///etc/passwd",
      "https://user:secret@home.test/",
      "https://home.test/#secret",
      "javascript:alert(1)",
      "bad",
    ])
      expect(parseDraft({ ...good, url })).toEqual({ error: "url" });
    for (const [patch, error] of [
      [{ name: " " }, "name"],
      [{ interval: "59" }, "interval"],
      [{ interval: "1e3" }, "interval"],
      [{ timeout: "30001" }, "timeout"],
      [{ min: "599", max: "200" }, "status"],
      [{ downAfter: "6" }, "downAfter"],
    ] as const)
      expect(parseDraft({ ...good, ...patch })).toEqual({ error });
  });
  it("restores bounded incomplete drafts and formats measured uptime without invented elapsed samples", () => {
    expect(readDraft(EMPTY_DRAFT)).toEqual(EMPTY_DRAFT);
    for (const raw of [
      null,
      [],
      {},
      { ...EMPTY_DRAFT, id: "" },
      { ...EMPTY_DRAFT, url: "a".repeat(2049) },
      { ...EMPTY_DRAFT, enabled: 1 },
    ])
      expect(readDraft(raw)).toBeNull();
    expect(durationParts(90061.5)).toEqual({ days: 1, hours: 1, minutes: 1, seconds: 1 });
    expect(durationParts(-1)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 });
  });
});
