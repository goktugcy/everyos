import { BridgeError, type DiskUsage } from "@everyos/app-sdk";
import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiskApp } from "../src/disk-app.tsx";
import { readHistory } from "../src/disk.ts";
import { storage, usage } from "./fixture.ts";

let rendered: RenderedApp | null = null;
const granted = [
  "storage:app",
  "files:pick",
  "files:save",
  "storage:usage.read",
  "system:metrics.read",
];
const files = { "/shared/notes.txt": "notes", "/shared/media/movie.mkv": "movie" };
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.restoreAllMocks();
});
async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(DiskApp, {
    publicDir: join(import.meta.dirname, "../public"),
    granted,
    files,
    pick: () => ["/shared"],
    host: { "disk.usage": () => usage, "system.storage": () => storage },
    ...options,
  });
  await vi.waitFor(() => expect(document.querySelector(".disk-main")).not.toBeNull());
  await vi.waitFor(() =>
    expect((byRole("button", "Choose folder") as HTMLButtonElement)?.disabled).toBe(false),
  );
  return rendered;
}
async function click(name: string, role = "button") {
  await new Promise((resolve) => setTimeout(resolve));
  const control = byRole(role, name);
  expect(control).not.toBeNull();
  control!.click();
}
async function choose() {
  await click("Choose folder");
  await vi.waitFor(() => expect(table("Files and folders")).not.toBeNull());
}
const table = (name: string) => document.querySelector(`table[aria-label="${name}"]`);
const rows = () => table("Files and folders")!.querySelectorAll("tbody tr");

describe("Disk Explorer", () => {
  it("scans a picked read-only folder, navigates within its handle and renders measured sizes and types", async () => {
    const { host } = await start({
      host: {
        "system.storage": () => storage,
        "disk.usage": (input) =>
          (input as { path: string }).path ? { ...usage, total: 1000, children: [] } : usage,
      },
    });
    await choose();
    expect(rows()).toHaveLength(2);
    expect(table("Largest files")!.textContent).toContain("media/movie.mkv");
    expect(table("File type statistics")!.textContent).toContain(".mkv");
    const open = host.calls.find((call) => call.method === "files.open");
    expect(open?.params).toMatchObject({ directory: true, persist: true, write: false });
    await click("media");
    await vi.waitFor(() => expect(rows()).toHaveLength(0));
    expect(
      host.calls
        .filter(
          (call) =>
            call.method === "host.call" &&
            (call.params as { operation: string }).operation === "disk.usage",
        )
        .map((call) => (call.params as { input: { path: string } }).input.path),
    ).toEqual(["", "media"]);
    await click("Parent folder");
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    expect(host.calls.some((call) => call.method === "files.write")).toBe(false);
  });

  it("restores the chosen directory handle and relative location across reopenings", async () => {
    const first = await start();
    await choose();
    await click("media");
    await vi.waitFor(() => expect(byRole("button", "media")?.hasAttribute("disabled")).toBe(true));
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(first.host.storage.get("settings")).toMatchObject({ path: "media" }),
    );
    const persisted = Object.fromEntries(first.host.storage);
    const handles = first.host.persistentHandles();
    first.unmount();
    rendered = null;
    const reopened = await start({ storage: persisted, handles });
    await vi.waitFor(() => expect(table("Files and folders")).not.toBeNull());
    const read = reopened.host.calls.find(
      (call) =>
        call.method === "host.call" &&
        (call.params as { operation: string }).operation === "disk.usage",
    );
    expect(read?.params).toMatchObject({ input: { handle: handles[0]!.id, path: "media" } });
    expect(reopened.host.calls.some((call) => call.method === "files.open")).toBe(false);
  });

  it("paginates only the displayed children and exports every collected child through the destination picker", async () => {
    const children = Array.from({ length: 250 }, (_, i) => ({
      name: `file-${i}.txt`,
      kind: "file" as const,
      size: 1,
      items: 1,
    }));
    const { host } = await start({
      host: {
        "system.storage": () => storage,
        "disk.usage": () => ({ ...usage, children, files: 250, total: 250 }),
      },
    });
    await choose();
    expect(rows()).toHaveLength(100);
    await click("Next");
    expect(rows()[0]?.textContent).toContain("file-100.txt");
    typeInto(byRole("searchbox", "Search this folder"), "file-249");
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    await click("Export report");
    await vi.waitFor(() =>
      expect(host.readText("/disk-report.json")).toContain('"schemaVersion": 1'),
    );
    const report = JSON.parse(host.readText("/disk-report.json")!) as {
      folder: { children: unknown[]; source: string };
    };
    expect(report.folder.children).toHaveLength(250);
    expect(report.folder.source).toBe("host");
    expect(host.calls.some((call) => call.method === "files.save")).toBe(true);
  });

  it("labels incomplete scans and excludes partial totals from trend observations", async () => {
    const { host } = await start({
      host: {
        "system.storage": () => storage,
        "disk.usage": () => ({ ...usage, truncated: true }),
      },
    });
    await choose();
    expect(byText(/Partial scan/)).not.toBeNull();
    expect(byText(/At least two measurements/)).not.toBeNull();
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(host.storage.has("history")).toBe(true));
    expect(
      readHistory(host.storage.get("history")).some((value) => value.key.includes("folder")),
    ).toBe(false);
  });

  it("shows mounted file systems independently, labels simulated values and preserves their source in reports", async () => {
    const { host } = await start({
      host: {
        "disk.usage": () => usage,
        "system.storage": () => ({ ...storage, source: "simulated" }),
      },
    });
    await click("Mounted storage", "tab");
    await vi.waitFor(() => expect(byRole("meter", "Used space")).not.toBeNull());
    expect(byRole("meter", "Used space")!.getAttribute("aria-valuenow")).toBe("60");
    expect(byText("Simulated data")).not.toBeNull();
    expect(byText(/do not describe the real host/)).not.toBeNull();
    expect(byText("ext4")).not.toBeNull();
    expect(byText("Read and write")).not.toBeNull();
    expect(byText("800 of 1,000 free")).not.toBeNull();
    await click("Export report");
    await vi.waitFor(() =>
      expect(host.readText("/disk-report.json")).toContain('"source": "simulated"'),
    );
    expect(JSON.parse(host.readText("/disk-report.json")!)).toMatchObject({
      folder: null,
      storage: { value: { source: "simulated" } },
    });
  });

  it("keeps the last successful scan with a stale warning after a failed refresh", async () => {
    let fail = false;
    await start({
      host: {
        "system.storage": () => storage,
        "disk.usage": () => {
          if (fail) throw new BridgeError("AGENT_UNAVAILABLE", "Internal");
          return usage;
        },
      },
    });
    await choose();
    fail = true;
    await click("Refresh");
    await vi.waitFor(() => expect(byText(/previous snapshot remains visible/)).not.toBeNull());
    expect(rows()).toHaveLength(2);
  });

  it("clears revoked folder data and ignores a late measurement from a revoked capability", async () => {
    const pending: ((value: DiskUsage) => void)[] = [];
    const { host } = await start({
      host: {
        "system.storage": () => storage,
        "disk.usage": () =>
          new Promise<DiskUsage>((done) => {
            pending.push(done);
          }),
      },
    });
    await click("Choose folder");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    host.setGranted(granted.filter((value) => value !== "storage:usage.read"));
    pending[0]!(usage);
    await vi.waitFor(() => expect(byText(/Folder analysis needs/)).not.toBeNull());
    expect(table("Files and folders")).toBeNull();
    expect(byText("notes.txt")).toBeNull();
    await click("Export report");
    await vi.waitFor(() => expect(host.readText("/disk-report.json")).toContain('"folder": null'));
    host.setGranted(granted);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!(usage);
    await vi.waitFor(() => expect(table("Files and folders")).not.toBeNull());
  });

  it("handles a withdrawn file share and translates the current interface", async () => {
    const { host } = await start();
    await choose();
    const id = host.persistentHandles()[0]!.id;
    host.revoke([id]);
    await vi.waitFor(() => expect(table("Files and folders")).toBeNull());
    expect(byText(/no longer available/)).not.toBeNull();
    host.setLocale("tr");
    await vi.waitFor(() => expect(byText("Disk Gezgini")).not.toBeNull());
    expect(byRole("button", "Klasör seç")).not.toBeNull();
  });
});
