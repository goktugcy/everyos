import type { TransferView } from "@everyos/shared";
import { createLogger } from "@everyos/logger";
import { describe, expect, it } from "vitest";
import { ApiError } from "./http/errors.ts";
import { TransferService, type TransferTask } from "./modules/transfers/transfer-service.ts";
import { createTestContext, json, TestClient, completeSetup } from "./test-support.ts";

const logger = createLogger({ name: "test", level: "silent", format: "json" });
const USER = "7b3c9f0e-1d2a-4c5b-8e6f-0a1b2c3d4e5f";

/** A task that moves bytes only when the test says so. */
function controlled(name: string, total = 100) {
  let release: (() => void) | null = null;
  let fail: ((error: unknown) => void) | null = null;
  let progress: Parameters<TransferTask["run"]>[0] | null = null;
  const task: TransferTask = {
    direction: "download",
    name,
    from: "Google Drive",
    to: "Ev",
    bytesTotal: total,
    run: (report, signal) =>
      new Promise<void>((resolve, reject) => {
        progress = report;
        release = resolve;
        fail = reject;
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  return {
    task,
    send: (bytes: number) => progress!.bytes(bytes),
    finish: () => release!(),
    fail: (error: unknown) => fail!(error),
    started: () => progress !== null,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("transfers", () => {
  it("runs two at a time per person, reports progress and ends failures with a code", async () => {
    const service = new TransferService({ now: Date.now, logger });
    const a = controlled("a.mp4");
    const b = controlled("b.mp4");
    const c = controlled("c.mp4");
    const first = service.start(USER, a.task);
    service.start(USER, b.task);
    const third = service.start(USER, c.task);
    await settle();
    expect([a.started(), b.started(), c.started()]).toEqual([true, true, false]);
    expect(service.list(USER).find((job) => job.id === third.id)?.state).toBe("queued");
    a.send(40);
    expect(service.list(USER).find((job) => job.id === first.id)).toMatchObject({
      state: "running",
      bytesDone: 40,
      bytesTotal: 100,
    });
    a.finish();
    await settle();
    expect(c.started()).toBe(true);
    b.fail(new ApiError(507, "FILES_INSUFFICIENT_SPACE", "full"));
    await settle();
    const states = Object.fromEntries(service.list(USER).map((job) => [job.name, job]));
    expect(states["a.mp4"]?.state).toBe("done");
    expect(states["b.mp4"]).toMatchObject({ state: "failed", error: "FILES_INSUFFICIENT_SPACE" });
    // Somebody else never sees them.
    expect(service.list("someone-else")).toEqual([]);
    service.cancel(USER, third.id);
    await settle();
    expect(service.list(USER).find((job) => job.id === third.id)?.state).toBe("cancelled");
    service.clear(USER);
    expect(service.list(USER)).toEqual([]);
    service.stop();
  });

  it("computes a smoothed speed and the time left, and coalesces live updates", async () => {
    const service = new TransferService({ now: Date.now, logger });
    const lists: TransferView[][] = [];
    const unsubscribe = service.subscribe(USER, (list) => lists.push(list));
    const job = controlled("big.iso", 10_000_000);
    service.start(USER, job.task);
    await settle();
    for (let i = 0; i < 20; i++) {
      job.send(100_000);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const view = service.list(USER)[0]!;
    expect(view.speed).toBeGreaterThan(200_000);
    expect(view.etaSeconds).toBeGreaterThan(0);
    // 20 progress calls in 1.2 s arrive as a handful of lists, not one per call.
    expect(lists.length).toBeLessThan(12);
    job.finish();
    unsubscribe();
    service.stop();
  });

  it("lists and cancels the caller's own transfers over HTTP", async () => {
    const ctx = await createTestContext();
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    const me = await json<{ user: { id: string } }>(await admin.get("/api/auth/session"));
    const job = controlled("photo.jpg");
    const started = ctx.services.transfers.start(me.user.id, job.task);
    expect(
      (await json<{ transfers: TransferView[] }>(await admin.get("/api/transfers"))).transfers,
    ).toHaveLength(1);
    expect((await admin.post(`/api/transfers/${started.id}/cancel`, {})).status).toBe(200);
    await settle();
    expect(ctx.services.transfers.list(me.user.id)[0]?.state).toBe("cancelled");
    expect(
      (await admin.post("/api/transfers/7b3c9f0e-1d2a-4c5b-8e6f-000000000000/cancel", {})).status,
    ).toBe(404);
  });
});
