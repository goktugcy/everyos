import { BridgeError, type SshKey, type HostResult } from "@everyos/app-sdk";
import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeysApp } from "../src/keys-app.tsx";
import { key } from "./fixture.ts";

const granted = ["secrets:ssh", "files:save", "clipboard:write"];
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.useRealTimers();
});
async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(KeysApp, {
    publicDir: join(import.meta.dirname, "../public"),
    granted,
    host: { "ssh.keys.list": () => ({ keys: [key()] }) },
    ...options,
  });
  await vi.waitFor(() => expect(byRole("button", "Generate key")).not.toBeNull());
  await new Promise((resolve) => setTimeout(resolve));
  return rendered;
}
async function click(name: string) {
  await new Promise((resolve) => setTimeout(resolve));
  expect(byRole("button", name)).not.toBeNull();
  byRole("button", name)!.click();
}
const table = () => document.querySelector('table[aria-label="SSH keys"]');
const dialog = () => document.querySelector("dialog[open]");
const password = () =>
  document.querySelectorAll<HTMLInputElement>('dialog[open] input[type="password"]');
const operations = () =>
  rendered!.host.calls
    .filter((call) => call.method === "host.call")
    .map((call) => call.params as { operation: string; input: unknown });
async function enterPassphrase(value = "test-passphrase") {
  await click("Export protected private key");
  typeInto(password()[0]!, value);
  typeInto(password()[1]!, value);
}

describe("SSH Keys", () => {
  it("shows public metadata, filters keys and copies only public material", async () => {
    const { host } = await start({
      host: {
        "ssh.keys.list": () => ({
          keys: [key(), key({ id: "2", name: "Server", hasPrivateKey: false })],
        }),
      },
    });
    await vi.waitFor(() => expect(table()?.textContent).toContain("Laptop"));
    expect(byText("SHA256:interface-test-fingerprint")).not.toBeNull();
    expect(byText(/Last retrieved:/)).not.toBeNull();
    await click("Copy public key");
    await vi.waitFor(() => expect(host.clipboard).toEqual([key().publicKey]));
    await click("Copy fingerprint");
    await vi.waitFor(() => expect(host.clipboard.at(-1)).toBe(key().fingerprint));
    typeInto(byRole("searchbox", "Search keys"), "Server");
    await vi.waitFor(() => expect(table()?.textContent).not.toContain("Laptop"));
    expect(byRole("button", "Export protected private key")).toBeNull();
    expect(host.storage.size).toBe(0);
  });
  it("generates a key and updates the selected key's metadata", async () => {
    let items: SshKey[] = [];
    await start({
      host: {
        "ssh.keys.list": () => ({ keys: items }),
        "ssh.keys.generate": () => {
          items = [key({ name: "New laptop" })];
          return items[0]!;
        },
        "ssh.keys.update": () => {
          items = [key({ name: "Renamed", comment: "Remote" })];
          return items[0]!;
        },
      },
    });
    await click("Generate key");
    typeInto(byRole("textbox", "Name"), "New laptop");
    typeInto(byRole("textbox", "Comment"), "Home access");
    await click("Save");
    await vi.waitFor(() => expect(table()?.textContent).toContain("New laptop"));
    expect(operations()).toContainEqual({
      operation: "ssh.keys.generate",
      input: { name: "New laptop", type: "ed25519", comment: "Home access" },
    });
    await click("Edit");
    typeInto(byRole("textbox", "Name"), "Renamed");
    typeInto(byRole("textbox", "Comment"), "Remote");
    await click("Save");
    await vi.waitFor(() => expect(table()?.textContent).toContain("Renamed"));
    expect(operations()).toContainEqual({
      operation: "ssh.keys.update",
      input: { id: "key-1", name: "Renamed", comment: "Remote" },
    });
  });
  it("clears a pasted private key and imports only public key text", async () => {
    let items: SshKey[] = [];
    await start({
      host: {
        "ssh.keys.list": () => ({ keys: items }),
        "ssh.keys.import": () => {
          items = [key({ name: "Imported", hasPrivateKey: false })];
          return items[0]!;
        },
      },
    });
    await click("Import public key");
    typeInto(byRole("textbox", "Name"), "Imported");
    typeInto(dialog()!.querySelector("textarea"), "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture");
    expect(dialog()!.querySelector("textarea")!.value).toBe("");
    await click("Save");
    expect(byRole("alert")).not.toBeNull();
    expect(operations().some((call) => call.operation === "ssh.keys.import")).toBe(false);
    typeInto(dialog()!.querySelector("textarea"), key().publicKey);
    await click("Save");
    await vi.waitFor(() => expect(table()?.textContent).toContain("Imported"));
    expect(operations()).toContainEqual({
      operation: "ssh.keys.import",
      input: { name: "Imported", publicKey: key().publicKey },
    });
    expect(byRole("button", "Export protected private key")).toBeNull();
  });
  it("exports public text through the EveryOS save picker", async () => {
    const { host } = await start({
      host: {
        "ssh.keys.list": () => ({ keys: [key()] }),
        "ssh.keys.export": () => ({
          text: key().publicKey + "\n",
          fileName: "Laptop.pub",
          encrypted: false,
        }),
      },
    });
    await vi.waitFor(() => expect(table()).not.toBeNull());
    await click("Export public key");
    await vi.waitFor(() => expect(host.readText("/Laptop.pub")).toBe(key().publicKey + "\n"));
    expect(operations()).toContainEqual({
      operation: "ssh.keys.export",
      input: { id: "key-1", private: false },
    });
  });
  it("clears passwords before a protected export, writes its result and never persists secrets", async () => {
    let resolve: ((value: HostResult<"ssh.keys.export">) => void) | undefined;
    const { host } = await start({
      host: {
        "ssh.keys.list": () => ({ keys: [key()] }),
        "ssh.keys.export": () =>
          new Promise<HostResult<"ssh.keys.export">>((done) => {
            resolve = done;
          }),
      },
    });
    await vi.waitFor(() => expect(table()).not.toBeNull());
    await enterPassphrase();
    await click("Continue");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    expect(password()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("test-passphrase");
    resolve!({ text: "encrypted-test-key", fileName: "Laptop.key" });
    await vi.waitFor(() => expect(host.readText("/Laptop.key")).toBe("encrypted-test-key"));
    expect(operations()).toContainEqual({
      operation: "ssh.keys.export",
      input: { id: "key-1", private: true, passphrase: "test-passphrase" },
    });
    expect(host.storage.size).toBe(0);
    expect(host.clipboard).toEqual([]);
    expect(host.calls.some((call) => call.method.startsWith("storage."))).toBe(false);
  });
  it("clears passwords on cancellation and suspend and suppresses cancelled-host errors", async () => {
    await start({
      host: {
        "ssh.keys.list": () => ({ keys: [key()] }),
        "ssh.keys.export": () => {
          throw new BridgeError("EVERYOS_CANCELLED", "Declined");
        },
      },
    });
    await vi.waitFor(() => expect(table()).not.toBeNull());
    await enterPassphrase();
    await click("Cancel");
    await click("Export protected private key");
    expect([...password()].map((input) => input.value)).toEqual(["", ""]);
    typeInto(password()[0]!, "suspended-secret");
    rendered!.host.emit("lifecycle.suspend", null);
    await vi.waitFor(() => expect(dialog()).toBeNull());
    rendered!.host.emit("lifecycle.resume", null);
    await enterPassphrase();
    await click("Continue");
    await vi.waitFor(() =>
      expect(operations().some((call) => call.operation === "ssh.keys.export")).toBe(true),
    );
    expect(byRole("alert")).toBeNull();
    expect(rendered!.host.calls.some((call) => call.method === "files.save")).toBe(false);
  });
  it("does not save a late private export after its key permission is revoked", async () => {
    let resolve: ((value: HostResult<"ssh.keys.export">) => void) | undefined;
    const { host } = await start({
      host: {
        "ssh.keys.list": () => ({ keys: [key()] }),
        "ssh.keys.export": () =>
          new Promise<HostResult<"ssh.keys.export">>((done) => {
            resolve = done;
          }),
      },
    });
    await vi.waitFor(() => expect(table()).not.toBeNull());
    await enterPassphrase();
    await click("Continue");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    host.setGranted(["files:save", "clipboard:write"]);
    await vi.waitFor(() => expect(byText(/This app needs secrets:ssh/)).not.toBeNull());
    resolve!({ text: "late-private-key", fileName: "Laptop.key" });
    await new Promise((done) => setTimeout(done, 25));
    expect(table()).toBeNull();
    expect(
      host.calls.some((call) => call.method === "files.save" || call.method === "files.write"),
    ).toBe(false);
  });
  it("does not write when file permission is revoked while the save picker is open", async () => {
    let resolve: ((value: string | null) => void) | undefined;
    const { host } = await start({
      host: {
        "ssh.keys.list": () => ({ keys: [key()] }),
        "ssh.keys.export": () => ({
          text: "protected-key",
          fileName: "Laptop.key",
        }),
      },
      saveAs: () =>
        new Promise<string | null>((done) => {
          resolve = done;
        }),
    });
    await vi.waitFor(() => expect(table()).not.toBeNull());
    await enterPassphrase();
    await click("Continue");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    host.setGranted(["secrets:ssh", "clipboard:write"]);
    await new Promise((done) => setTimeout(done));
    resolve!("/Laptop.key");
    await vi.waitFor(() =>
      expect(host.calls.some((call) => call.method === "files.save")).toBe(true),
    );
    expect(host.calls.some((call) => call.method === "files.write")).toBe(false);
  });
  it("confirms deletion of public-only keys and delegates private-key approval to EveryOS", async () => {
    let approved = false;
    let items = [key({ hasPrivateKey: false })];
    await start({
      confirm: () => approved,
      host: {
        "ssh.keys.list": () => ({ keys: items }),
        "ssh.keys.delete": () => {
          items = [];
          return null;
        },
      },
    });
    await vi.waitFor(() => expect(table()).not.toBeNull());
    await click("Delete");
    await vi.waitFor(() =>
      expect(rendered!.host.calls.some((call) => call.method === "dialog.confirm")).toBe(true),
    );
    expect(operations().some((call) => call.operation === "ssh.keys.delete")).toBe(false);
    approved = true;
    await click("Delete");
    await vi.waitFor(() => expect(table()).toBeNull());
    items = [key()];
    await click("Refresh");
    await vi.waitFor(() => expect(table()).not.toBeNull());
    const before = rendered!.host.calls.filter((call) => call.method === "dialog.confirm").length;
    await click("Delete");
    await vi.waitFor(() => expect(table()).toBeNull());
    expect(rendered!.host.calls.filter((call) => call.method === "dialog.confirm")).toHaveLength(
      before,
    );
  });
  it("keeps a failed snapshot and explains busy crypto and missing OpenSSH tools", async () => {
    let fail = false;
    let missing = false;
    await start({
      host: {
        "ssh.keys.list": () => {
          if (fail) throw new BridgeError("UNAVAILABLE", "Internal");
          return { keys: [key()] };
        },
        "ssh.keys.generate": () => {
          throw new BridgeError(
            missing ? "HOST_CAPABILITY_UNAVAILABLE" : "RATE_LIMITED",
            "Internal",
          );
        },
      },
    });
    await vi.waitFor(() => expect(table()).not.toBeNull());
    fail = true;
    await click("Refresh");
    await vi.waitFor(() => expect(byText(/Refresh failed/)).not.toBeNull());
    expect(table()?.textContent).toContain("Laptop");
    await click("Generate key");
    typeInto(byRole("textbox", "Name"), "Busy");
    await click("Save");
    await vi.waitFor(() => expect(byText(/Another key generation/)).not.toBeNull());
    missing = true;
    await click("Save");
    await vi.waitFor(() => expect(byText(/needs ssh-keygen/)).not.toBeNull());
  });
  it("waits for pending reads, pauses polling while suspended and refreshes on resume", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pending: ((value: { keys: SshKey[] }) => void)[] = [];
    let blocking = true;
    let attempts = 0;
    const { host } = await start({
      host: {
        "ssh.keys.list": () => {
          attempts++;
          return blocking
            ? new Promise<{ keys: SshKey[] }>((done) => pending.push(done))
            : { keys: [key()] };
        },
      },
    });
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const initial = attempts;
    await vi.advanceTimersByTimeAsync(30000);
    expect(attempts).toBe(initial);
    blocking = false;
    pending.forEach((resolve) => resolve({ keys: [key()] }));
    await vi.waitFor(() => expect(table()).not.toBeNull());
    await vi.advanceTimersByTimeAsync(15000);
    await vi.waitFor(() => expect(attempts).toBe(initial + 1));
    host.emit("lifecycle.suspend", null);
    await new Promise((done) => setTimeout(done));
    await vi.advanceTimersByTimeAsync(45000);
    expect(attempts).toBe(initial + 1);
    host.emit("lifecycle.resume", null);
    await vi.waitFor(() => expect(attempts).toBe(initial + 2));
  });
});
