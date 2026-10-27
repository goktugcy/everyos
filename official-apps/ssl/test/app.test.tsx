import { BridgeError } from "@everyos/app-sdk";
import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SslApp } from "../src/ssl-app.tsx";
import { tlsResult } from "./fixture.ts";

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
async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(SslApp, {
    publicDir: join(import.meta.dirname, "../public"),
    granted: ["storage:app", "network:outbound"],
    host: { "net.tls": () => tlsResult() },
    ...options,
  });
  await vi.waitFor(() =>
    expect(byRole("button", options.locale === "tr" ? "İncele" : "Inspect")).not.toBeNull(),
  );
  return rendered;
}

describe("SSL Inspector", () => {
  it("shows actual TLS details, name mismatch, trust and validity warnings for the whole chain", async () => {
    const { host } = await start();
    typeInto(byRole("textbox", "Host name or IP address"), "example.test");
    typeInto(byRole("textbox", "Server name (SNI), optional"), "sni.test");
    await click("Inspect");
    await vi.waitFor(() => expect(byText("TLSv1.3")).not.toBeNull());
    expect(
      byText("The chain could not be verified against this server’s trusted roots."),
    ).not.toBeNull();
    expect(byText("The certificate does not match the requested server name.")).not.toBeNull();
    expect(byText("Certificate expires within 30 days")).not.toBeNull();
    expect(byText("Certificate expired")).not.toBeNull();
    expect(byText("CN=Test CA")).not.toBeNull();
    expect(byText("DNS:other.test")).not.toBeNull();
    expect(byText("AB:CD:EF")).not.toBeNull();
    expect(byText("A1B2")).not.toBeNull();
    expect(byText("Self-signed")).not.toBeNull();
    expect(host.calls.find((call) => call.method === "host.call")?.params).toEqual({
      operation: "net.tls",
      input: { host: "example.test", port: 443, servername: "sni.test", timeoutMs: 10000 },
    });
  });

  it("saves validated endpoints with SNI, flushes on pagehide and inspects them after reopening", async () => {
    const { host } = await start({ storage: { endpoints: [{ invalid: true }] } });
    typeInto(byRole("textbox", "Host name or IP address"), "bücher.de");
    typeInto(byRole("spinbutton", "TLS port"), "8443");
    typeInto(byRole("textbox", "Server name (SNI), optional"), "sni.test");
    await click("Save endpoint");
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(host.storage.get("endpoints")).toEqual([
        { host: "xn--bcher-kva.de", port: 8443, servername: "sni.test" },
      ]),
    );
    const storage = Object.fromEntries(host.storage);
    rendered!.unmount();
    rendered = null;
    const next = await start({ storage });
    await click(/^xn--bcher-kva.de:8443/);
    await vi.waitFor(() =>
      expect(next.host.calls.find((call) => call.method === "host.call")?.params).toMatchObject({
        input: { host: "xn--bcher-kva.de", port: 8443, servername: "sni.test" },
      }),
    );
    await click("Remove xn--bcher-kva.de:8443");
    await vi.waitFor(() =>
      expect(byText("Save an endpoint to inspect it again later.")).not.toBeNull(),
    );
    expect(next.host.calls.find((call) => call.method === "dialog.confirm")?.params).toMatchObject({
      destructive: true,
    });
  });

  it("validates targets before sending, explains policy failures and follows language and permission changes", async () => {
    let blocked = true;
    const { host } = await start({
      host: {
        "net.tls": () => {
          if (blocked)
            throw new BridgeError("DESKTOP_APP_NETWORK_BLOCKED", "Internal", {
              host: "example.test",
              port: 443,
              reason: "policy",
            });
          return tlsResult({ authorized: true, hostnameMatches: true });
        },
      },
    });
    typeInto(byRole("textbox", "Host name or IP address"), "https://example.test");
    await click("Inspect");
    expect(byRole("alert")?.textContent).toContain("valid host name");
    expect(host.calls.some((call) => call.method === "host.call")).toBe(false);
    typeInto(byRole("textbox", "Host name or IP address"), "example.test");
    await click("Inspect");
    await vi.waitFor(() => expect(byRole("alert")?.textContent).toContain("App Store"));
    host.setLocale("tr");
    await vi.waitFor(() => expect(byRole("alert")?.textContent).toContain("Uygulama Mağazası"));
    blocked = false;
    await click("İncele");
    await vi.waitFor(() => expect(byText("Zincir doğrulandı")).not.toBeNull());
    expect(byText("Ad sertifikayla eşleşiyor")).not.toBeNull();
    host.setGranted(["storage:app"]);
    await vi.waitFor(() =>
      expect((byRole("button", "İncele") as HTMLButtonElement).disabled).toBe(true),
    );
    expect(byRole("alert")?.textContent).toContain("ağı kullanmasına izin verilmedi");
  });

  it("labels absent optional TLS information and missing certificate chains", async () => {
    const fixture = tlsResult({ protocol: null, cipher: null, alpn: null, chain: [] });
    await start({
      storage: { draft: { host: "example.test", port: "443", servername: "" } },
      host: { "net.tls": () => fixture },
    });
    await click("Inspect");
    await vi.waitFor(() =>
      expect(byText("The endpoint did not return certificate details.")).not.toBeNull(),
    );
    expect(byText("Not available")).not.toBeNull();
  });
});
