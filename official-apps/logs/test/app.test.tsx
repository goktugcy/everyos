import { BridgeError, type LogEntry, type LogPage, type LogQuery } from "@everyos/app-sdk";
import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogsApp } from "../src/logs-app.tsx";
import { localTime } from "../src/logs.ts";

function record(cursor: string, ts: number, message: string, priority = 6): LogEntry {
  return {
    cursor,
    ts,
    message,
    priority,
    unit: "cache.service",
    identifier: "cache",
    pid: 123,
    hostname: "host.test",
  };
}
function service(initial?: LogEntry[], source: LogPage["source"] = "host") {
  let entries = initial ?? [
    record("one", Date.now() - 1000, "[cache]. Failed\n" + "x".repeat(400), 3),
    record("two", Date.now() - 2000, "cacheX Ready", 6),
  ];
  const queries: LogQuery[] = [];
  const host: NonNullable<MockHostOptions["host"]> = {
    "logs.query": (value) => {
      const query = value as LogQuery;
      queries.push(query);
      let rows = entries
        .filter(
          (entry) =>
            (!query.unit || entry.unit === query.unit) &&
            (query.priority === undefined || entry.priority <= query.priority) &&
            (query.since === undefined || entry.ts >= query.since) &&
            (query.until === undefined || entry.ts <= query.until) &&
            (!query.grep || entry.message.toLowerCase().includes(query.grep.toLowerCase())),
        )
        .toSorted((a, b) => b.ts - a.ts);
      if (query.before) rows = rows.slice(rows.findIndex((row) => row.cursor === query.before) + 1);
      return {
        source,
        entries: rows.slice(0, query.limit ?? 200),
        hasMore: rows.length > (query.limit ?? 200),
      };
    },
  };
  return {
    host,
    queries,
    setEntries(next: LogEntry[]) {
      entries = next;
    },
  };
}
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.useRealTimers();
});
async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(LogsApp, {
    publicDir: join(import.meta.dirname, "../public"),
    granted: ["storage:app", "files:save", "logs:read"],
    host: service().host,
    ...options,
  });
  await vi.waitFor(() => expect(byRole("button", "Apply")).not.toBeNull());
  return rendered;
}
async function click(name: string | RegExp) {
  await new Promise((resolve) => setTimeout(resolve));
  await vi.waitFor(() => expect(byRole("button", name)).not.toBeNull());
  byRole("button", name)!.click();
}
function select(label: string, value: string) {
  const element = byRole("combobox", label) as HTMLSelectElement;
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}
const table = () => document.querySelector('table[aria-label="Journal records"]');

describe("Log Viewer", () => {
  it("queries literal messages and severity thresholds, opens full record metadata and exports complete loaded rows", async () => {
    const api = service();
    const { host } = await start({ host: api.host });
    await vi.waitFor(() => expect(table()?.querySelectorAll("tbody tr")).toHaveLength(2));
    typeInto(byRole("searchbox", "Search messages"), "[cache].");
    typeInto(byRole("textbox", "Systemd unit"), "cache.service");
    select("Priority", "4");
    await click("Apply");
    await vi.waitFor(() => expect(table()?.querySelectorAll("tbody tr")).toHaveLength(1));
    expect(api.queries.at(-1)).toMatchObject({
      grep: "[cache].",
      unit: "cache.service",
      priority: 4,
      limit: 200,
    });
    expect(table()?.textContent).not.toContain("x".repeat(400));
    table()!.querySelector<HTMLElement>("tbody tr")!.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".logs-message")?.textContent).toContain("x".repeat(400)),
    );
    expect(byText("host.test")).not.toBeNull();
    expect(byText("123")).not.toBeNull();
    await click("Close");
    await click("Export JSON");
    await vi.waitFor(() => expect(host.readText("/logs.json")).toContain('"grep": "[cache]."'));
    const report = JSON.parse(host.readText("/logs.json")!) as {
      source: string;
      entries: LogEntry[];
    };
    expect(report.source).toBe("host");
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.message).toContain("x".repeat(400));
  });

  it("saves and restores filters and confirms removing a preset while retaining journal rows", async () => {
    let approved = false;
    const first = await start({ prompt: () => "Cache errors", confirm: () => approved });
    await vi.waitFor(() => expect(table()?.querySelectorAll("tbody tr")).toHaveLength(2));
    typeInto(byRole("textbox", "Systemd unit"), "cache.service");
    await click("Apply");
    await click("Save filter");
    await vi.waitFor(() => expect(byRole("button", "Cache errors")).not.toBeNull());
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(first.host.storage.get("filters")).toMatchObject([
        { name: "Cache errors", draft: { unit: "cache.service" } },
      ]),
    );
    const storage = Object.fromEntries(first.host.storage);
    rendered!.unmount();
    rendered = null;
    const second = await start({ storage, confirm: () => approved });
    await vi.waitFor(() => expect(table()?.querySelectorAll("tbody tr")).toHaveLength(2));
    expect((byRole("textbox", "Systemd unit") as HTMLInputElement).value).toBe("cache.service");
    await click("Cache errors");
    await click("Remove Cache errors");
    await vi.waitFor(() =>
      expect(second.host.calls.some((call) => call.method === "dialog.confirm")).toBe(true),
    );
    expect(byRole("button", "Cache errors")).not.toBeNull();
    approved = true;
    await click("Remove Cache errors");
    await vi.waitFor(() => expect(byRole("button", "Cache errors")).toBeNull());
    expect(table()?.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(
      second.host.calls
        .filter((call) => call.method === "host.call")
        .every((call) => (call.params as { operation: string }).operation === "logs.query"),
    ).toBe(true);
  });

  it("polls only while active, merges new cursors on resume and freezes the view when paused", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const api = service();
    const { host } = await start({ host: api.host });
    await vi.waitFor(() => expect(table()?.querySelectorAll("tbody tr")).toHaveLength(2));
    await click("Start live updates");
    await vi.waitFor(() => expect(byText("Live")).not.toBeNull());
    await vi.waitFor(() =>
      expect((byRole("button", "Refresh") as HTMLButtonElement).disabled).toBe(false),
    );
    host.emit("lifecycle.suspend", null);
    await vi.waitFor(() => expect(byText("Updates paused")).not.toBeNull());
    const before = api.queries.length;
    await vi.advanceTimersByTimeAsync(9000);
    expect(api.queries).toHaveLength(before);
    api.setEntries([
      record("fresh", Date.now(), "Fresh message"),
      record("one", Date.now() - 1000, "[cache]. Failed", 3),
      record("two", Date.now() - 2000, "cacheX Ready"),
    ]);
    host.emit("lifecycle.resume", null);
    await vi.waitFor(() => expect(table()?.textContent).toContain("Fresh message"));
    expect(table()?.querySelectorAll("tbody tr")).toHaveLength(3);
    await click("Pause live updates");
    const paused = api.queries.length;
    api.setEntries([record("later", Date.now() + 1000, "Later message")]);
    await vi.advanceTimersByTimeAsync(9000);
    expect(api.queries).toHaveLength(paused);
    expect(table()?.textContent).not.toContain("Later message");
  });

  it("loads older cursor pages, paginates the bounded buffer and exports all loaded rows", async () => {
    const now = Date.now();
    const api = service(
      Array.from({ length: 250 }, (_, i) => record(`entry-${i}`, now - i * 1000, `Message ${i}`)),
    );
    const { host } = await start({ host: api.host });
    await vi.waitFor(() => expect(table()?.querySelectorAll("tbody tr")).toHaveLength(100));
    await click("Older entries");
    await vi.waitFor(() =>
      expect(api.queries.some((query) => query.before === "entry-199")).toBe(true),
    );
    await vi.waitFor(() =>
      expect((byRole("button", "Older entries") as HTMLButtonElement).disabled).toBe(true),
    );
    await click("Next");
    await click("Next");
    await vi.waitFor(() => expect(table()?.querySelectorAll("tbody tr")).toHaveLength(50));
    await click("Export JSON");
    await vi.waitFor(() => expect(host.readText("/logs.json")).toContain("Message 249"));
    expect(
      (JSON.parse(host.readText("/logs.json")!) as { entries: unknown[] }).entries,
    ).toHaveLength(250);
  });

  it("validates filters before sending, uses local custom times and disables live reads with an end time", async () => {
    const api = service();
    await start({ host: api.host });
    await vi.waitFor(() => expect(table()).not.toBeNull());
    const before = api.queries.length;
    typeInto(byRole("textbox", "Systemd unit"), "../cache.service");
    await click("Apply");
    expect(byRole("alert")?.textContent).toContain("exact systemd unit name");
    expect(api.queries).toHaveLength(before);
    typeInto(byRole("textbox", "Systemd unit"), "");
    select("Time range", "custom");
    await new Promise((resolve) => setTimeout(resolve));
    const since = localTime(Date.now() - 600000),
      until = localTime(Date.now());
    const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]');
    typeInto(dateInputs[0]!, since);
    typeInto(dateInputs[1]!, until);
    await click("Apply");
    await vi.waitFor(() => expect(api.queries.at(-1)?.until).toBe(new Date(until).getTime()));
    expect(api.queries.at(-1)?.since).toBe(new Date(since).getTime());
    expect((byRole("button", "Start live updates") as HTMLButtonElement).disabled).toBe(true);
  });

  it("labels and exports simulated records explicitly", async () => {
    const { host } = await start({ host: service(undefined, "simulated").host });
    await vi.waitFor(() => expect(byText("Simulated data")).not.toBeNull());
    expect(byRole("status")?.textContent).toContain("do not describe the real host");
    await click("Export JSON");
    await vi.waitFor(() => expect(host.readText("/logs.json")).toContain('"source": "simulated"'));
  });

  it("clears records and ignores an outstanding reply after log permission is revoked", async () => {
    let finish: ((value: unknown) => void) | undefined;
    let delayed = false;
    const api = service();
    const { host } = await start({
      host: {
        "logs.query": (value) =>
          delayed
            ? new Promise((resolve) => {
                finish = resolve;
              })
            : api.host["logs.query"]!(value),
      },
    });
    await vi.waitFor(() => expect(table()).not.toBeNull());
    delayed = true;
    await click("Refresh");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    host.setGranted(["storage:app"]);
    await vi.waitFor(() => expect(table()).toBeNull());
    finish!({
      source: "host",
      entries: [record("late", Date.now(), "Late private record")],
      hasMore: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(table()).toBeNull();
    expect(byText("Late private record")).toBeNull();
    expect((byRole("button", "Apply") as HTMLButtonElement).disabled).toBe(true);
    host.setLocale("tr");
    await vi.waitFor(() => expect(byRole("alert")?.textContent).toContain("günlük okuma yetkisi"));
  });

  it("retains the last successful snapshot with an explicit stale notice when a refresh fails", async () => {
    let failed = false;
    const api = service();
    await start({
      host: {
        "logs.query": (value) => {
          if (failed) throw new BridgeError("AGENT_UNAVAILABLE", "Internal");
          return api.host["logs.query"]!(value);
        },
      },
    });
    await vi.waitFor(() => expect(table()?.querySelectorAll("tbody tr")).toHaveLength(2));
    failed = true;
    await click("Refresh");
    await vi.waitFor(() => expect(byRole("alert")?.textContent).toContain("Could not read logs"));
    expect(table()?.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(byText(/last successful result remains visible/)).not.toBeNull();
  });
});
