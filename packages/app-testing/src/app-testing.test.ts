// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountMockHost } from "./index.ts";

/*
 * The real SDK (`createApp`) against the MOCK host, in a DOM: what an app's own tests do.
 */

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.resetModules();
});

async function start(options: Parameters<typeof mountMockHost>[0]) {
  const host = mountMockHost(options);
  unmount = () => host.unmount();
  // Each test gets a fresh SDK module (it connects once per page).
  const { createApp } = await import("@everyos/app-sdk");
  return { host, app: await createApp() };
}

describe("the mock host", () => {
  it("answers the SDK like the desktop: storage, files, dialogs and lifecycle", async () => {
    const { host, app } = await start({
      app: { id: "dev.example.notes", version: "1.2.0", name: "Notes" },
      granted: ["storage:app", "files:pick", "files:save", "clipboard:write"],
      locale: "tr",
      files: { "/notes/today.md": "# Bugün", "/photo.png": new Uint8Array([1, 2, 3]) },
      storage: { count: 4 },
    });
    expect(app.app).toEqual({ id: "dev.example.notes", version: "1.2.0", name: "Notes" });
    expect(app.everyos.version).toBe("mock");
    expect(app.locale.current).toBe("tr");

    expect(await app.storage.get("count")).toBe(4);
    await app.storage.set("count", 5);
    expect(host.storage.get("count")).toBe(5);

    const [handle] = await app.files.open({ accept: [".md"] });
    expect(handle).toMatchObject({ name: "today.md", kind: "file", type: "text/markdown" });
    expect(await app.files.readText(handle!)).toBe("# Bugün");
    const target = await app.files.save({ suggestedName: "out.txt" });
    expect(await app.files.write(target!, "saved text")).toBe(10);
    expect(host.readText("/out.txt")).toBe("saved text");

    expect(await app.dialogs.confirm("Delete?")).toBe(true);
    await app.clipboard.writeText("copied");
    expect(host.clipboard).toEqual(["copied"]);
    await app.window.setTitle("Notes · today");
    expect(host.window.title).toBe("Notes · today");
    await app.lifecycle.ready();
    expect(host.ready).toBe(true);
  });

  it("refuses what is not granted, and window-only methods in widgets", async () => {
    const { host, app } = await start({ granted: ["storage:app"] });
    await expect(app.notifications.send({ title: "Hi" })).rejects.toMatchObject({
      code: "EVERYOS_PERMISSION_DENIED",
      details: { capability: "notifications:send" },
    });
    await expect(app.host.call("system.metrics")).rejects.toMatchObject({
      code: "EVERYOS_PERMISSION_DENIED",
    });
    // Granting later is heard by the app.
    const changed = new Promise<ReadonlySet<string>>((resolve) =>
      app.permissions.onChange(resolve),
    );
    host.setGranted(["storage:app", "notifications:send"]);
    expect([...(await changed)]).toContain("notifications:send");
    await app.notifications.send({ title: "Hi", body: "there" });
    expect(host.notifications).toMatchObject([{ title: "Hi", body: "there" }]);
    expect(host.calls.filter((call) => !call.ok).map((call) => call.error)).toEqual([
      "EVERYOS_PERMISSION_DENIED",
      "EVERYOS_PERMISSION_DENIED",
    ]);
  });

  it("serves host data only as configured, and says so otherwise", async () => {
    const { app } = await start({
      granted: ["network:outbound"],
      host: { "net.dns": () => ({ status: "ok", records: [] }) },
    });
    await expect(app.host.call("net.dns", { name: "example.com", type: "A" })).resolves.toEqual({
      status: "ok",
      records: [],
    });
    await expect(
      app.host.call("net.http", { method: "GET", url: "https://example.com" }),
    ).rejects.toMatchObject({ code: "EVERYOS_MOCK_UNANSWERED" });
  });

  it("keeps widgets to what widgets can do", async () => {
    const { app } = await start({ kind: "widget", widgetId: "timer", granted: ["files:pick"] });
    expect(app.instance).toMatchObject({ kind: "widget", widgetId: "timer" });
    await expect(app.files.open()).rejects.toMatchObject({ code: "EVERYOS_UNKNOWN_METHOD" });
  });
});
