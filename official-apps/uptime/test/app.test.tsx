import {
  BridgeError,
  type NetMonitor,
  type NetMonitorInput,
  type SystemInfo,
} from "@everyos/app-sdk";
import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UptimeApp } from "../src/uptime-app.tsx";
import { HealthWidget } from "../src/health-widget.tsx";
import { info, monitor, services } from "./fixture.ts";

const granted = [
  "storage:app",
  "system:metrics.read",
  "system:services.read",
  "network:outbound",
  "notifications:send",
  "widgets:register",
];
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.useRealTimers();
});
const defaults = (): MockHostOptions => ({
  granted,
  host: {
    "system.info": () => info(),
    "system.services": () => services,
    "net.monitors.list": () => ({ monitors: [monitor()] }),
    "net.monitors.history": () => ({ checks: [] }),
  },
});
async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(UptimeApp, {
    ...defaults(),
    publicDir: join(import.meta.dirname, "../public"),
    ...options,
  });
  await vi.waitFor(() => expect(byRole("button", "New monitor")).not.toBeNull());
  await new Promise((resolve) => setTimeout(resolve));
  return rendered;
}
async function click(name: string) {
  await new Promise((resolve) => setTimeout(resolve));
  expect(byRole("button", name)).not.toBeNull();
  byRole("button", name)!.click();
}
const table = (name: string) => document.querySelector(`table[aria-label="${name}"]`);

describe("Uptime", () => {
  it("shows measured host uptime, real service state and endpoint availability with independent sources", async () => {
    await start();
    await vi.waitFor(() => expect(byText("1d 1h 1m 1s")).not.toBeNull());
    expect(byText("Observed checks passing")).not.toBeNull();
    expect(table("Reported services")!.textContent).toContain("ssh.service");
    expect(table("Reported services")!.textContent).toContain("backup.service");
    expect(byText("100%")).not.toBeNull();
    expect(byText("50%")).not.toBeNull();
    expect(byText("4 ms")).not.toBeNull();
    expect(byText("Host data")).not.toBeNull();
  });
  it("creates a validated approved endpoint with verified TLS and notification settings", async () => {
    const items: NetMonitor[] = [];
    const { host } = await start({
      host: {
        "system.info": () => info(),
        "system.services": () => services,
        "net.monitors.list": () => ({ monitors: items }),
        "net.monitors.history": () => ({ checks: [] }),
        "net.monitors.save": (input) => {
          const value = { ...monitor(), ...(input as NetMonitorInput), id: "new-endpoint" };
          items.push(value);
          return value;
        },
      },
    });
    await click("New monitor");
    typeInto(byRole("textbox", "Name"), "Home service");
    typeInto(byRole("textbox", "HTTP or HTTPS URL"), "https://user:secret@home.test/");
    await click("Save monitor");
    expect(byText(/without credentials or a fragment/)).not.toBeNull();
    expect(
      host.calls.some(
        (call) =>
          call.method === "host.call" &&
          (call.params as { operation: string }).operation === "net.monitors.save",
      ),
    ).toBe(false);
    typeInto(byRole("textbox", "HTTP or HTTPS URL"), "https://home.test/");
    await click("Save monitor");
    await vi.waitFor(() => expect(byRole("dialog")).not.toBeNull());
    await vi.waitFor(() => expect((byRole("dialog") as HTMLDialogElement)?.open).toBe(false));
    const saved = host.calls.find(
      (call) =>
        call.method === "host.call" &&
        (call.params as { operation: string }).operation === "net.monitors.save",
    );
    expect(saved?.params).toMatchObject({
      input: {
        name: "Home service",
        method: "GET",
        url: "https://home.test/",
        verifyTls: true,
        notify: true,
        downAfter: 1,
        expectStatus: { min: 200, max: 299 },
      },
    });
    expect(host.calls.some((call) => call.method === "dialog.confirm")).toBe(false);
    expect(byText("Home service")).not.toBeNull();
  });
  it("keeps an unfinished draft across closing and confirms before discarding it", async () => {
    const first = await start();
    await click("New monitor");
    typeInto(byRole("textbox", "Name"), "Unfinished");
    typeInto(byRole("textbox", "HTTP or HTTPS URL"), "https://draft.test/");
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(first.host.storage.get("draft")).toMatchObject({ name: "Unfinished" }),
    );
    const storage = Object.fromEntries(first.host.storage);
    first.unmount();
    rendered = null;
    let confirm = false;
    const reopened = await start({ storage, confirm: () => confirm });
    await click("Continue draft");
    expect((byRole("textbox", "Name") as HTMLInputElement).value).toBe("Unfinished");
    await click("Discard draft");
    await vi.waitFor(() =>
      expect(reopened.host.calls.some((call) => call.method === "dialog.confirm")).toBe(true),
    );
    expect((byRole("dialog") as HTMLDialogElement).open).toBe(true);
    confirm = true;
    await click("Discard draft");
    await vi.waitFor(() => expect((byRole("dialog") as HTMLDialogElement).open).toBe(false));
  });
  it("checks, pauses, resumes and deletes only after the person confirms", async () => {
    let item: NetMonitor | null = { ...monitor(), checkedAt: null };
    let confirm = false;
    const { host } = await start({
      confirm: () => confirm,
      host: {
        "system.info": () => info(),
        "system.services": () => services,
        "net.monitors.list": () => ({ monitors: item ? [item] : [] }),
        "net.monitors.history": () => ({ checks: [] }),
        "net.monitors.check": () => {
          item = monitor();
          return item;
        },
        "net.monitors.save": (input) => {
          item = {
            ...monitor(),
            ...(input as NetMonitorInput),
            id: "endpoint-1",
            state: (input as NetMonitorInput).enabled ? "up" : "paused",
          };
          return item;
        },
        "net.monitors.delete": () => {
          item = null;
          return null;
        },
      },
    });
    await vi.waitFor(() => expect(byRole("button", "Check now")).not.toBeNull());
    await click("Check now");
    await vi.waitFor(() => expect(byText("100%")).not.toBeNull());
    await click("Pause");
    await vi.waitFor(() => expect(byRole("button", "Enable")).not.toBeNull());
    await click("Enable");
    await vi.waitFor(() => expect(byRole("button", "Pause")).not.toBeNull());
    await click("Delete");
    await vi.waitFor(() =>
      expect(host.calls.some((call) => call.method === "dialog.confirm")).toBe(true),
    );
    expect(
      host.calls.some(
        (call) =>
          call.method === "host.call" &&
          (call.params as { operation: string }).operation === "net.monitors.delete",
      ),
    ).toBe(false);
    confirm = true;
    await click("Delete");
    await vi.waitFor(() => expect(byText("No monitors yet")).not.toBeNull());
  });
  it("shows actual failure/success transitions and labels simulated service values without a healthy summary", async () => {
    const at = Date.now();
    await start({
      host: {
        "system.info": () => info(),
        "system.services": () => ({ ...services, source: "simulated" }),
        "net.monitors.list": () => ({ monitors: [monitor()] }),
        "net.monitors.history": () => ({
          checks: [
            { at: at - 2000, ok: false, status: 503, ms: 2, error: "status" },
            { at: at - 1000, ok: true, status: 200, ms: 1, error: null },
          ],
        }),
      },
    });
    await vi.waitFor(() => expect(byText("Successful check observed")).not.toBeNull());
    expect(byText("Failure first observed")).not.toBeNull();
    expect(byText(/may have started earlier/)).not.toBeNull();
    expect(byText("Simulated data")).not.toBeNull();
    expect(byText("Insufficient data")).not.toBeNull();
    expect(byText("Observed checks passing")).toBeNull();
    expect(table("Check history")?.querySelectorAll("tbody tr")).toHaveLength(2);
  });
  it("retains a failed refresh's last measurement while changing the health summary to unknown", async () => {
    let fail = false;
    await start({
      host: {
        "system.info": () => {
          if (fail) throw new BridgeError("AGENT_UNAVAILABLE", "Internal");
          return info();
        },
        "system.services": () => services,
        "net.monitors.list": () => ({ monitors: [monitor()] }),
        "net.monitors.history": () => ({ checks: [] }),
      },
    });
    await vi.waitFor(() => expect(byText("Observed checks passing")).not.toBeNull());
    fail = true;
    await click("Refresh");
    await vi.waitFor(() => expect(byText("Insufficient data")).not.toBeNull());
    expect(byText("1d 1h 1m 1s")).not.toBeNull();
    expect(byRole("alert")).not.toBeNull();
  });
  it("ignores a late host read after its capability is revoked", async () => {
    let resolve: ((value: SystemInfo) => void) | undefined;
    const { host } = await start({
      host: {
        "system.info": () =>
          new Promise<SystemInfo>((done) => {
            resolve = done;
          }),
        "system.services": () => services,
        "net.monitors.list": () => ({ monitors: [monitor()] }),
        "net.monitors.history": () => ({ checks: [] }),
      },
    });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    host.setGranted(granted.filter((cap) => cap !== "system:metrics.read"));
    resolve!(info());
    await vi.waitFor(() => expect(byText(/Host uptime needs/)).not.toBeNull());
    expect(byText("1d 1h 1m 1s")).toBeNull();
    expect(byText("host.test")).toBeNull();
  });
  it("waits for outstanding reads before polling, pauses on suspend and refreshes on resume", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pending: ((value: SystemInfo) => void)[] = [];
    let blocking = true;
    let attempts = 0;
    const { host } = await start({
      host: {
        "system.info": () => {
          attempts++;
          if (!blocking) return info();
          return new Promise<SystemInfo>((done) => {
            pending.push(done);
          });
        },
        "system.services": () => services,
        "net.monitors.list": () => ({ monitors: [monitor()] }),
        "net.monitors.history": () => ({ checks: [] }),
      },
    });
    // The mock records completed answers; count starts to include outstanding requests.
    const reads = () => attempts;
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    await new Promise((done) => setTimeout(done));
    const initial = reads();
    await vi.advanceTimersByTimeAsync(30000);
    expect(reads()).toBe(initial);
    blocking = false;
    pending.forEach((resolve) => resolve(info()));
    await vi.waitFor(() => expect(byText("1d 1h 1m 1s")).not.toBeNull());
    await vi.advanceTimersByTimeAsync(15000);
    await vi.waitFor(() => expect(reads()).toBe(initial + 1));
    host.emit("lifecycle.suspend", null);
    await new Promise((done) => setTimeout(done));
    await vi.advanceTimersByTimeAsync(45000);
    expect(reads()).toBe(initial + 1);
    host.emit("lifecycle.resume", null);
    await vi.waitFor(() => expect(reads()).toBe(initial + 2));
  });
});

describe("Uptime widget", () => {
  it("reads its capability subset and opens the full window without a file picker or a mutation", async () => {
    rendered = await renderApp(HealthWidget, {
      ...defaults(),
      publicDir: join(import.meta.dirname, "../public"),
      kind: "widget",
      widgetId: "health",
      granted: ["system:metrics.read", "system:services.read", "network:outbound"],
    });
    await vi.waitFor(() => expect(byText("Observed checks passing")).not.toBeNull());
    await click("Open Uptime");
    await vi.waitFor(() =>
      expect(rendered!.host.calls.some((call) => call.method === "window.open")).toBe(true),
    );
    expect(
      rendered.host.calls
        .filter((call) => call.method === "host.call")
        .every((call) =>
          ["system.info", "system.services", "net.monitors.list"].includes(
            (call.params as { operation: string }).operation,
          ),
        ),
    ).toBe(true);
  });
  it("labels simulated coverage and updates language and grants while mounted", async () => {
    rendered = await renderApp(HealthWidget, {
      ...defaults(),
      publicDir: join(import.meta.dirname, "../public"),
      kind: "widget",
      widgetId: "health",
      host: { ...defaults().host, "system.services": () => ({ ...services, source: "simulated" }) },
    });
    await vi.waitFor(() => expect(byText("Simulated data")).not.toBeNull());
    expect(byText("Insufficient data")).not.toBeNull();
    rendered.host.setLocale("tr");
    await vi.waitFor(() => expect(byText("Simüle veri")).not.toBeNull());
    rendered.host.setGranted([]);
    await vi.waitFor(() => expect(byText("1g 1sa 1dk 1sn")).toBeNull());
  });
});
