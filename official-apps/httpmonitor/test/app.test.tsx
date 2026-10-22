import {
  BridgeError,
  type NetMonitor,
  type NetMonitorCheck,
  type NetMonitorInput,
} from "@everyos/app-sdk";
import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpMonitorApp } from "../src/monitor-app.tsx";
import { EMPTY_DRAFT } from "../src/monitor.ts";
import { fixture } from "./fixture.ts";

let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});
const click = async (name: string | RegExp) => {
  await new Promise((resolve) => setTimeout(resolve));
  await vi.waitFor(() => expect(byRole("button", name)).not.toBeNull());
  byRole("button", name)!.click();
};

function service(initial: NetMonitor[] = []) {
  let monitors = initial;
  const saved: NetMonitorInput[] = [];
  let checks: NetMonitorCheck[] = [
    { at: 1700000000000, ok: true, status: 200, ms: 12.5, error: null },
  ];
  const host: NonNullable<MockHostOptions["host"]> = {
    "net.monitors.list": () => ({ monitors }),
    "net.monitors.history": () => ({ checks }),
    "net.monitors.save": (value) => {
      const input = value as NetMonitorInput;
      saved.push(input);
      const result = fixture({
        ...input,
        id: input.id ?? "monitor-1",
        keyword: input.keyword ?? null,
        state: input.enabled ? "pending" : "paused",
      });
      monitors = [...monitors.filter((m) => m.id !== result.id), result];
      return result;
    },
    "net.monitors.check": () => {
      monitors = monitors.map((m) => ({
        ...m,
        state: "down",
        lastStatus: 503,
        lastError: "status",
        checkedAt: Date.now(),
      }));
      checks = [{ at: Date.now(), ok: false, status: 503, ms: 20, error: "status" }, ...checks];
      return monitors[0]!;
    },
    "net.monitors.delete": () => {
      monitors = [];
      return null;
    },
  };
  return { host, saved };
}
async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(HttpMonitorApp, {
    publicDir: join(import.meta.dirname, "../public"),
    granted: ["storage:app", "files:save", "network:outbound", "notifications:send"],
    host: service().host,
    ...options,
  });
  await vi.waitFor(() =>
    expect(
      byRole("button", options.storage?.draft ? "Continue draft" : "New monitor"),
    ).not.toBeNull(),
  );
  return rendered;
}

describe("HTTP Monitor", () => {
  it("does not show the previous endpoint's history while another endpoint is loading", async () => {
    let resolveHistory: ((value: { checks: NetMonitorCheck[] }) => void) | undefined;
    await start({
      host: {
        ...service([fixture(), fixture({ id: "monitor-2", name: "Second service" })]).host,
        "net.monitors.history": (value) => {
          const { id } = value as { id: string };
          return id === "monitor-2"
            ? new Promise((resolve) => {
                resolveHistory = resolve;
              })
            : {
                checks: [{ at: 1700000000000, ok: true, status: 201, ms: 1, error: null }],
              };
        },
      },
    });
    await vi.waitFor(() => expect(document.querySelector("tbody")?.textContent).toContain("201"));
    await click(/^Second service/);
    await vi.waitFor(() => expect(resolveHistory).toBeTypeOf("function"));
    expect(document.querySelector("tbody")?.textContent).not.toContain("201");
    resolveHistory!({
      checks: [{ at: 1700000060000, ok: false, status: 503, ms: 10, error: "status" }],
    });
    await vi.waitFor(() => expect(document.querySelector("tbody")?.textContent).toContain("503"));
  });

  it("creates and edits a monitor, checks actual host state, pauses it, exports history and confirms deletion", async () => {
    const api = service();
    const { host } = await start({ host: api.host });
    await click("New monitor");
    typeInto(byRole("textbox", "Name"), "Home service");
    typeInto(byRole("textbox", "HTTP or HTTPS URL"), "https://service.test/health");
    typeInto(byRole("textbox", "Required body text (optional)"), "ready");
    await click("Save monitor");
    await vi.waitFor(() => expect(byText("Awaiting check")).not.toBeNull());
    expect(api.saved[0]).toMatchObject({
      name: "Home service",
      url: "https://service.test/health",
      keyword: "ready",
      notify: true,
    });
    document.querySelector("dialog")!.dispatchEvent(new Event("close"));
    await new Promise((resolve) => setTimeout(resolve));
    expect(host.calls.some((call) => call.method === "dialog.confirm")).toBe(false);
    await click("Check now");
    await vi.waitFor(() => expect(byText("Unexpected HTTP status")).not.toBeNull());
    expect(document.querySelector(".monitor-stats")?.textContent).toContain("503");
    expect(document.querySelectorAll(".monitor-timeline li")).toHaveLength(2);
    expect((byRole("button", /Wait \d+ s/) as HTMLButtonElement).disabled).toBe(true);
    await click("Export CSV");
    await vi.waitFor(() =>
      expect(host.readText("/http-monitor-history.csv")).toContain('"false","503","20","status"'),
    );
    await click("Edit");
    typeInto(byRole("textbox", "Name"), "Renamed service");
    await click("Save monitor");
    await vi.waitFor(() => expect(api.saved).toHaveLength(2));
    expect(api.saved[1]).toMatchObject({ id: "monitor-1", name: "Renamed service" });
    await vi.waitFor(() => expect(byRole("button", "Pause")).not.toBeNull());
    await click("Pause");
    await vi.waitFor(() => expect(byText("Paused")).not.toBeNull());
    expect(api.saved[2]?.enabled).toBe(false);
    await click("Delete");
    await vi.waitFor(() => expect(byText("No monitors yet")).not.toBeNull());
    expect(host.calls.find((c) => c.method === "dialog.confirm")?.params).toMatchObject({
      destructive: true,
    });
  });

  it("restores unfinished configuration after reload and validates locally before sending", async () => {
    const first = await start();
    await click("New monitor");
    typeInto(byRole("textbox", "Name"), "Unfinished");
    typeInto(byRole("textbox", "HTTP or HTTPS URL"), "ftp://service.test");
    await click("Save monitor");
    await vi.waitFor(() => expect(byRole("alert")?.textContent).toContain("HTTP or HTTPS URL"));
    expect(
      first.host.calls.some(
        (c) =>
          c.method === "host.call" &&
          (c.params as { operation: string }).operation === "net.monitors.save",
      ),
    ).toBe(false);
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(first.host.storage.get("draft")).toMatchObject({
        name: "Unfinished",
        url: "ftp://service.test",
      }),
    );
    const storage = Object.fromEntries(first.host.storage);
    rendered!.unmount();
    rendered = null;
    await start({ storage, confirm: () => false });
    await click("Continue draft");
    expect((byRole("textbox", "Name") as HTMLInputElement).value).toBe("Unfinished");
    expect((byRole("textbox", "HTTP or HTTPS URL") as HTMLInputElement).value).toBe(
      "ftp://service.test",
    );
    await click("Discard draft");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(byRole("dialog")).not.toBeNull();
  });

  it("shows policy guidance in the active language and clears state when network permission is revoked", async () => {
    const api = service([fixture()]);
    const { host } = await start({
      host: {
        ...api.host,
        "net.monitors.check": () => {
          throw new BridgeError("DESKTOP_APP_NETWORK_BLOCKED", "Internal", {
            host: "service.test",
            port: 443,
            reason: "policy",
          });
        },
      },
    });
    await vi.waitFor(() => expect(byText("98%")).not.toBeNull());
    await click("Check now");
    await vi.waitFor(() => expect(byRole("alert")?.textContent).toContain("service.test:443"));
    host.setLocale("tr");
    await vi.waitFor(() => expect(byRole("alert")?.textContent).toContain("Uygulama Mağazası"));
    host.setGranted(["storage:app"]);
    await vi.waitFor(() => expect(document.querySelector(".monitor-stats")).toBeNull());
    expect((byRole("button", "Yeni izleyici") as HTMLButtonElement).disabled).toBe(true);
    expect(byRole("alert")?.textContent).toContain("dış ağ izni");
  });

  it("keeps large history bounded in the table and exports all returned checks", async () => {
    const checks = Array.from({ length: 251 }, (_, i) => ({
      at: 1700000000000 - i * 60000,
      ok: true,
      status: 200,
      ms: i,
      error: null,
    })).reverse();
    const { host } = await start({
      host: { ...service([fixture()]).host, "net.monitors.history": () => ({ checks }) },
    });
    await vi.waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(100));
    expect(document.querySelectorAll(".monitor-timeline li")).toHaveLength(60);
    expect(document.querySelector("tbody tr td:last-child")?.textContent).toBe("0 ms");
    expect([...document.querySelectorAll(".monitor-timeline li")].at(-1)?.textContent).toMatch(
      / · 0 ms$/,
    );
    await click("Next");
    await click("Next");
    await vi.waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(51));
    await click("Export CSV");
    await vi.waitFor(() =>
      expect(host.readText("/http-monitor-history.csv")?.split("\r\n")).toHaveLength(253),
    );
  });

  it("shows unavailable notification permission and clears body assertion when selecting HEAD", async () => {
    await start({
      granted: ["storage:app", "network:outbound"],
      storage: { draft: { ...EMPTY_DRAFT, name: "Draft", keyword: "ready" } },
    });
    await click("Continue draft");
    const select = byRole("combobox", "Method") as HTMLSelectElement;
    select.value = "HEAD";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(byRole("textbox", "Required body text (optional)")).toBeNull());
    expect(byText(/Notifications need the notifications:send permission/)).not.toBeNull();
  });
});
