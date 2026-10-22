import { BridgeError, type NetDnsQuery, type NetDnsResult } from "@everyos/app-sdk";
import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DnsApp } from "../src/dns-app.tsx";
import { COMMON_TYPES } from "../src/dns.ts";

let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});
const click = async (label: string | RegExp) => {
  await new Promise((resolve) => setTimeout(resolve));
  const button = byRole("button", label);
  if (!(button instanceof HTMLElement)) throw new Error(`Missing button ${label}`);
  button.click();
};
const select = (label: string, value: string) => {
  const element = byRole("combobox", label) as HTMLSelectElement;
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
};
const answer = (query: NetDnsQuery): NetDnsResult => ({
  name: query.name,
  type: query.type,
  ms: 12.5,
  servers: [query.server ?? "192.0.2.53"],
  status: query.type === "A" ? "ok" : "no-data",
  records: query.type === "A" ? [{ type: "A", address: "192.0.2.10", ttl: 60 }] : [],
});
async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(DnsApp, {
    publicDir: join(import.meta.dirname, "../public"),
    granted: ["storage:app", "network:outbound", "clipboard:write"],
    host: { "net.dns": (input) => answer(input as NetDnsQuery) },
    ...options,
  });
  await vi.waitFor(() =>
    expect(byRole("button", options.locale === "tr" ? "Sorgula" : "Look up")).not.toBeNull(),
  );
  return rendered;
}

describe("DNS Lookup", () => {
  it("queries common records serially, shows real results and timing, copies and restores history", async () => {
    const asked: NetDnsQuery[] = [];
    let inFlight = 0;
    const { host } = await start({
      host: {
        "net.dns": async (input) => {
          expect(inFlight++).toBe(0);
          await Promise.resolve();
          inFlight--;
          asked.push(input as NetDnsQuery);
          return answer(input as NetDnsQuery);
        },
      },
    });
    typeInto(byRole("textbox", "Name or IP address for PTR"), "EXAMPLE.TEST.");
    await click("Look up");
    await vi.waitFor(() => expect(asked).toHaveLength(6));
    expect(asked.map((q) => q.type)).toEqual(COMMON_TYPES);
    expect(asked.every((q) => q.name === "example.test" && q.server === null)).toBe(true);
    await vi.waitFor(() => expect(byText("192.0.2.10", "code")).not.toBeNull());
    expect(byText("12.5 ms")).not.toBeNull();
    expect(document.querySelector('table[aria-label="A records"]')).not.toBeNull();
    expect(byText("No records of this type")).not.toBeNull();
    await click("Copy all results");
    await vi.waitFor(() =>
      expect(host.clipboard).toEqual(["example.test.\t60\tIN\tA\t192.0.2.10"]),
    );
    await vi.waitFor(
      () => expect(host.storage.get("history")).toMatchObject([{ name: "example.test", port: 53 }]),
      { timeout: 2000 },
    );
    const storage = Object.fromEntries(host.storage);
    rendered!.unmount();
    rendered = null;
    await start({ storage });
    expect((byRole("textbox", "Name or IP address for PTR") as HTMLInputElement).value).toBe(
      "EXAMPLE.TEST.",
    );
    expect(byRole("button", /example.test/)).not.toBeNull();
  });

  it("validates names and custom resolvers before sending, and reruns saved custom ports", async () => {
    const { host } = await start({
      storage: {
        history: [{ name: "example.test", types: ["TXT"], server: "127.0.0.1", port: 5353, at: 1 }],
      },
    });
    typeInto(byRole("textbox", "Name or IP address for PTR"), "https://bad.test");
    await click("Look up");
    expect(byRole("alert")?.textContent).toContain("valid DNS name");
    expect(host.calls.filter((call) => call.method === "host.call")).toHaveLength(0);
    typeInto(byRole("textbox", "Name or IP address for PTR"), "example.test");
    select("Resolver", "custom");
    await vi.waitFor(() => expect(byRole("textbox", "Resolver IP address")).not.toBeNull());
    typeInto(byRole("textbox", "Resolver IP address"), "not-an-ip");
    await click("Look up");
    expect(byRole("alert")?.textContent).toContain("resolver IP");
    await click(/example\.test/);
    await vi.waitFor(() =>
      expect(host.calls.find((call) => call.method === "host.call")?.params).toMatchObject({
        operation: "net.dns",
        input: { server: "127.0.0.1", serverPort: 5353, type: "TXT" },
      }),
    );
  });

  it("explains policy refusals in Turkish, recovers, and responds to permission withdrawal", async () => {
    let blocked = true;
    const { host } = await start({
      locale: "tr",
      storage: { settings: { name: "example.test", type: "A", server: "cloudflare" } },
      host: {
        "net.dns": (input) => {
          if (blocked)
            throw new BridgeError("DESKTOP_APP_NETWORK_BLOCKED", "internal", {
              host: "1.1.1.1",
              port: 53,
              reason: "no-rule",
            });
          return answer(input as NetDnsQuery);
        },
      },
    });
    await click("Sorgula");
    await vi.waitFor(() => expect(byRole("alert")?.textContent).toContain("1.1.1.1:53"));
    expect(byRole("alert")?.textContent).toContain("Uygulama Mağazası");
    blocked = false;
    await click("Sorgula");
    await vi.waitFor(() => expect(byText("192.0.2.10", "code")).not.toBeNull());
    host.setGranted(["storage:app", "clipboard:write"]);
    await vi.waitFor(() =>
      expect((byRole("button", "Sorgula") as HTMLButtonElement).disabled).toBe(true),
    );
    expect(byRole("alert")?.textContent).toContain("ağı kullanmasına izin verilmedi");
    host.setGranted(["storage:app", "network:outbound", "clipboard:write"]);
    await vi.waitFor(() =>
      expect((byRole("button", "Sorgula") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("asks before clearing history and tolerates corrupt persisted values", async () => {
    const { host } = await start({
      storage: {
        settings: null,
        history: [
          { name: "example.test", types: ["A"], server: null, port: 53, at: 1 },
          { bad: true },
        ],
      },
      confirm: () => false,
    });
    await click("Clear");
    expect(byRole("button", /example.test/)).not.toBeNull();
    await vi.waitFor(() =>
      expect(host.calls.find((call) => call.method === "dialog.confirm")?.params).toMatchObject({
        destructive: true,
      }),
    );
    rendered!.unmount();
    rendered = null;
    const next = await start({ storage: Object.fromEntries(host.storage), confirm: () => true });
    await click("Clear");
    await vi.waitFor(() => expect(next.host.storage.get("history")).toEqual([]), { timeout: 2000 });
    expect(byText("Completed queries appear here. Select one to run it again.")).not.toBeNull();
  });
});
