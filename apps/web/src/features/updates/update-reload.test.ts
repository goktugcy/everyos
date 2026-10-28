import { describe, expect, it, vi } from "vitest";
import type { SelfUpdateStatus } from "@everyos/shared";
import { createUpdateReload } from "./update-reload.ts";

function status(overrides: Partial<SelfUpdateStatus> = {}): SelfUpdateStatus {
  return {
    source: "host",
    installedVersion: "0.2.0",
    architecture: "arm64",
    configured: true,
    reason: null,
    checkedAt: 100,
    available: null,
    job: {
      id: "completed-job",
      version: "0.2.0",
      previousVersion: "0.1.0",
      backupId: "backup",
      state: "succeeded",
      createdAt: 10,
      finishedAt: 100,
      error: null,
    },
    ...overrides,
  };
}

function setup(currentVersion = "0.1.0") {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const reload = vi.fn();
  const beforeReload = vi.fn(() => Promise.resolve());
  const options = { currentVersion, storage, reload, beforeReload };
  return { ...options, observe: createUpdateReload(options) };
}

describe("completed update reload", () => {
  it("waits for a successful finished job and matching running version", async () => {
    const { observe, reload } = setup();
    const success = status();
    for (const state of [
      "queued",
      "installing",
      "restarting",
      "rolling-back",
      "rolled-back",
      "failed",
    ] as const)
      await observe(status({ job: { ...success.job!, state } }));
    await observe(status({ job: null }));
    await observe(status({ job: { ...success.job!, finishedAt: null } }));
    await observe(status({ installedVersion: "0.1.0" }));
    expect(reload).not.toHaveBeenCalled();
    await observe(success);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("flushes preferences first and coalesces simultaneous polling and stream completion", async () => {
    const fixture = setup();
    let finish!: () => void;
    fixture.beforeReload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = fixture.observe(status());
    const duplicate = fixture.observe(status());
    expect(fixture.beforeReload).toHaveBeenCalledOnce();
    expect(fixture.reload).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, duplicate]);
    expect(fixture.reload).toHaveBeenCalledOnce();
    await createUpdateReload(fixture)(status());
    expect(fixture.reload).toHaveBeenCalledOnce();
  });

  it("does not reload a bundle that is already current", async () => {
    const fixture = setup("0.2.0");
    await fixture.observe(status());
    expect(fixture.beforeReload).not.toHaveBeenCalled();
    expect(fixture.reload).not.toHaveBeenCalled();
  });

  it("can try again after flushing fails", async () => {
    const fixture = setup();
    fixture.beforeReload.mockRejectedValueOnce(new Error("offline"));
    await fixture.observe(status());
    expect(fixture.reload).not.toHaveBeenCalled();
    await fixture.observe(status());
    expect(fixture.reload).toHaveBeenCalledOnce();
  });

  it("remains once-only in the tab if browser storage is blocked", async () => {
    const fixture = setup();
    const observe = createUpdateReload({
      ...fixture,
      storage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    await observe(status());
    await observe(status());
    expect(fixture.reload).toHaveBeenCalledOnce();
  });
});
