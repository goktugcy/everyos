import { BridgeError, type SystemSockets } from "@everyos/app-sdk";
import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortsApp } from "../src/ports-app.tsx";

const sockets: SystemSockets = {
  source: "host",
  listening: [
    { protocol: "tcp", address: "0.0.0.0", port: 443, process: "nginx" },
    { protocol: "udp", address: "127.0.0.1", port: 53, process: "resolver" },
    { protocol: "tcp", address: "::1", port: 8080, process: null },
  ],
  connections: { established: 4, timeWait: 2, other: 1 },
};
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});
async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(PortsApp, {
    publicDir: join(import.meta.dirname, "../public"),
    granted: ["storage:app", "files:save", "system:sockets.read"],
    host: { "system.sockets": () => sockets },
    ...options,
  });
  await vi.waitFor(() => expect(byRole("searchbox", "Search listeners")).not.toBeNull());
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

describe("Port Inspector", () => {
  it("shows host listeners and connection counts, filters by process and protocol and exports the matching snapshot", async () => {
    const { host } = await start();
    await vi.waitFor(() => expect(byText("nginx")).not.toBeNull());
    expect(document.querySelectorAll("tbody tr")).toHaveLength(3);
    const initialCalls = host.calls.filter((call) => call.method === "host.call").length;
    expect(initialCalls).toBeGreaterThan(0);
    expect(document.querySelector(".ports-stats")?.textContent).toContain("Established TCP4");
    expect(byText("Unavailable")).not.toBeNull();
    typeInto(byRole("searchbox", "Search listeners"), "nginx 443");
    await vi.waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(1));
    await click("Export CSV");
    await vi.waitFor(() =>
      expect(host.readText("/listening-ports.csv")).toContain(
        '"tcp","0.0.0.0","443","nginx","wildcard"',
      ),
    );
    expect(host.readText("/listening-ports.csv")).not.toContain("resolver");
    await click("Reset filters");
    select("Protocol", "udp");
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain("resolver"),
    );
    expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(host.calls.filter((call) => call.method === "host.call")).toHaveLength(initialCalls);
    expect(host.calls.find((call) => call.method === "host.call")?.params).toEqual({
      operation: "system.sockets",
      input: null,
    });
  });

  it("persists validated filters and applies family and scope after reopening", async () => {
    const first = await start();
    select("Address family", "ipv6");
    await vi.waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(1));
    select("Bind scope", "loopback");
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(first.host.storage.get("filters")).toMatchObject({
        family: "ipv6",
        scope: "loopback",
      }),
    );
    const storage = Object.fromEntries(first.host.storage);
    rendered!.unmount();
    rendered = null;
    await start({ storage });
    await vi.waitFor(() => expect(document.querySelector("tbody")?.textContent).toContain("8080"));
    expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("labels simulated data in the interface and exports its source", async () => {
    const { host } = await start({
      host: { "system.sockets": () => ({ ...sockets, source: "simulated" }) },
    });
    await vi.waitFor(() => expect(byText("Simulated data")).not.toBeNull());
    expect(byRole("status")?.textContent).toContain("do not describe real open ports");
    await click("Export CSV");
    await vi.waitFor(() => expect(host.readText("/listening-ports.csv")).toContain('"simulated"'));
  });

  it("keeps the last snapshot on a failed refresh, localizes errors and clears it after permission revocation", async () => {
    let failed = false;
    const { host } = await start({
      host: {
        "system.sockets": () => {
          if (failed) throw new BridgeError("AGENT_UNAVAILABLE", "Internal");
          return sockets;
        },
      },
    });
    await vi.waitFor(() => expect(byText("nginx")).not.toBeNull());
    failed = true;
    await click("Refresh");
    await vi.waitFor(() => expect(byText(/The previous snapshot remains visible/)).not.toBeNull());
    expect(byText("nginx")).not.toBeNull();
    host.setLocale("tr");
    await vi.waitFor(() =>
      expect(byRole("alert")?.textContent).toContain("Host soketleri okunamadı"),
    );
    host.setGranted(["storage:app"]);
    await vi.waitFor(() => expect(document.querySelector(".ports-table")).toBeNull());
    expect(byRole("alert")?.textContent).toContain("host soketlerini okuma iznine");
    expect((byRole("button", "Yenile") as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports an unsupported host without fabricated listeners", async () => {
    await start({
      host: {
        "system.sockets": () => {
          throw new BridgeError("HOST_CAPABILITY_UNAVAILABLE", "Unsupported");
        },
      },
    });
    await vi.waitFor(() => expect(byRole("alert")?.textContent).toContain("requires Linux"));
    expect(document.querySelector(".ports-table")).toBeNull();
    expect((byRole("button", "Export CSV") as HTMLButtonElement).disabled).toBe(true);
  });

  it("pages large results and exports all matching rows", async () => {
    const { host } = await start({
      host: {
        "system.sockets": () => ({
          ...sockets,
          listening: Array.from({ length: 250 }, (_, i) => ({
            protocol: "tcp",
            address: "127.0.0.1",
            port: 1000 + i,
            process: null,
          })),
        }),
      },
    });
    await vi.waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(100));
    await click("Next");
    await click("Next");
    await vi.waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(50));
    await click("Export CSV");
    await vi.waitFor(() =>
      expect(host.readText("/listening-ports.csv")?.split("\r\n")).toHaveLength(252),
    );
  });
});
