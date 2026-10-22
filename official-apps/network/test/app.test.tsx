import { BridgeError } from "@everyos/app-sdk";
import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkApp } from "../src/network-app.tsx";
import { metrics, network, response } from "./fixture.ts";

let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.useRealTimers();
});
async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(NetworkApp, {
    publicDir: join(import.meta.dirname, "../public"),
    granted: [
      "storage:app",
      "files:save",
      "system:network.read",
      "system:metrics.read",
      "network:outbound",
    ],
    host: {
      "system.network": () => network,
      "system.metrics": () => metrics,
      "net.http": () => response,
    },
    ...options,
  });
  await vi.waitFor(() => expect(byRole("button", "Check endpoint")).not.toBeNull());
  return rendered;
}
async function click(name: string | RegExp) {
  await new Promise((resolve) => setTimeout(resolve));
  await vi.waitFor(() => expect(byRole("button", name)).not.toBeNull());
  byRole("button", name)!.click();
}

describe("Network Tools", () => {
  it("selects one interface for detail while retaining all interfaces in traffic data and the saved selection", async () => {
    const second = { ...network.interfaces[0]!, name: "eth1", up: false, addresses: [] };
    const first = await start({
      host: {
        "system.network": () => ({ ...network, interfaces: [...network.interfaces, second] }),
        "system.metrics": () => metrics,
      },
    });
    await vi.waitFor(() => expect(byRole("combobox", "Interface")).not.toBeNull());
    const select = byRole("combobox", "Interface") as HTMLSelectElement;
    select.value = "eth1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector(".network-interface h3")?.textContent).toBe("eth1"),
    );
    expect(document.querySelectorAll(".network-interface")).toHaveLength(1);
    expect(byText("Down")).not.toBeNull();
    expect(document.querySelector('table[aria-label="Interface traffic"]')?.textContent).toContain(
      "eth0",
    );
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(first.host.storage.get("settings")).toMatchObject({ interfaceName: "eth1" }),
    );
  });

  it("shows reported interfaces, addresses, default gateways, DNS and measured traffic with independent sources", async () => {
    await start({
      host: {
        "system.network": () => network,
        "system.metrics": () => ({ ...metrics, source: "simulated" }),
      },
    });
    await vi.waitFor(() => expect(byText("192.0.2.10/24")).not.toBeNull());
    expect(byText("2001:db8::10/64")).not.toBeNull();
    expect(byText("02:00:00:00:00:01")).not.toBeNull();
    expect(byText("192.0.2.1")).not.toBeNull();
    expect(byText("9.9.9.9")).not.toBeNull();
    await vi.waitFor(() => expect(byText("2 KB/s")).not.toBeNull());
    expect(byText("Host data")).not.toBeNull();
    expect(byText("Simulated data")).not.toBeNull();
    expect(byRole("status")?.textContent).toContain("do not describe the real host");
  });

  it("uses a scoped HEAD request and reports HTTP responses independently from status success", async () => {
    const { host } = await start();
    typeInto(byRole("textbox", "HTTP or HTTPS URL"), "https://service.test/");
    await click("Check endpoint");
    await vi.waitFor(() => expect(byText("HTTP response received")).not.toBeNull());
    expect(document.querySelector(".network-probe-result")?.textContent).toContain("404 Not Found");
    expect(
      host.calls.find(
        (call) =>
          call.method === "host.call" &&
          (call.params as { operation: string }).operation === "net.http",
      )?.params,
    ).toEqual({
      operation: "net.http",
      input: {
        method: "HEAD",
        url: "https://service.test/",
        followRedirects: true,
        verifyTls: true,
        timeoutMs: 10000,
      },
    });
    await click("Export report");
    await vi.waitFor(() =>
      expect(host.readText("/network-diagnostics.json")).toContain('"status": 404'),
    );
    expect(host.readText("/network-diagnostics.json")).not.toContain("endpoint-secret");
    expect(host.readText("/network-diagnostics.json")).not.toContain("private response");
  });

  it("persists the endpoint draft, validates before sending, and translates policy guidance when language changes", async () => {
    const first = await start({
      host: {
        "system.network": () => network,
        "system.metrics": () => metrics,
        "net.http": () => {
          throw new BridgeError("DESKTOP_APP_NETWORK_BLOCKED", "Internal", {
            host: "service.test",
            port: 443,
            reason: "policy",
          });
        },
      },
    });
    typeInto(byRole("textbox", "HTTP or HTTPS URL"), "file:///etc/passwd");
    await click("Check endpoint");
    expect(byText(/Enter an HTTP or HTTPS URL/)).not.toBeNull();
    expect(
      first.host.calls.some(
        (call) =>
          call.method === "host.call" &&
          (call.params as { operation: string }).operation === "net.http",
      ),
    ).toBe(false);
    typeInto(byRole("textbox", "HTTP or HTTPS URL"), "https://service.test/");
    await click("Check endpoint");
    await vi.waitFor(() => expect(byText(/service.test:443/)).not.toBeNull());
    first.host.setLocale("tr");
    await vi.waitFor(() => expect(byText(/Uygulama Mağazası/)).not.toBeNull());
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(first.host.storage.get("settings")).toMatchObject({ url: "https://service.test/" }),
    );
    const storage = Object.fromEntries(first.host.storage);
    rendered!.unmount();
    rendered = null;
    await start({ storage });
    expect((byRole("textbox", "HTTP or HTTPS URL") as HTMLInputElement).value).toBe(
      "https://service.test/",
    );
  });

  it("renders missing measurements without inventing zeros and preserves the last snapshot on refresh failures", async () => {
    let failed = false;
    await start({
      host: {
        "system.network": () => {
          if (failed) throw new BridgeError("AGENT_UNAVAILABLE", "Internal");
          return network;
        },
        "system.metrics": () => ({ ...metrics, interfaces: null }),
      },
    });
    await vi.waitFor(() =>
      expect(byText("Per-interface traffic rates are unavailable on this host.")).not.toBeNull(),
    );
    failed = true;
    await click("Refresh");
    await vi.waitFor(() => expect(byText(/The previous snapshot remains visible/)).not.toBeNull());
    expect(byText("192.0.2.10/24")).not.toBeNull();
  });

  it("clears private host state and ignores late probe results after permission revocation", async () => {
    let finish: ((value: unknown) => void) | undefined;
    const { host } = await start({
      host: {
        "system.network": () => network,
        "system.metrics": () => metrics,
        "net.http": () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    });
    await vi.waitFor(() => expect(byText("192.0.2.10/24")).not.toBeNull());
    typeInto(byRole("textbox", "HTTP or HTTPS URL"), "https://service.test/");
    await click("Check endpoint");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    host.setGranted(["storage:app"]);
    await vi.waitFor(() => expect(document.querySelector(".network-interface")).toBeNull());
    finish!(response);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector(".network-probe-result")).toBeNull();
    expect((byRole("button", "Check endpoint") as HTMLButtonElement).disabled).toBe(true);
  });

  it("suspends automatic polling while hidden and refreshes immediately on resume", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { host } = await start();
    await vi.waitFor(() => expect(byText("2 KB/s")).not.toBeNull());
    const checkbox = byRole("checkbox", "Refresh host data every 10 seconds while active")!;
    checkbox.click();
    await new Promise((resolve) => setTimeout(resolve));
    host.emit("lifecycle.suspend", null);
    await vi.waitFor(() => expect(host.storage.get("settings")).toMatchObject({ auto: true }));
    const before = host.calls.filter((call) => call.method === "host.call").length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(host.calls.filter((call) => call.method === "host.call")).toHaveLength(before);
    host.emit("lifecycle.resume", null);
    await vi.waitFor(() =>
      expect(host.calls.filter((call) => call.method === "host.call").length).toBeGreaterThan(
        before,
      ),
    );
  });
});
