import { mountMockHost } from "@everyos/app-testing";
import type { EveryOSApp } from "@everyos/app-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoardStore,
  BoardTooLargeError,
  CHUNK_CHARS,
  MAX_STASH_CHUNKS,
  pack,
  splitForStorage,
  unpack,
} from "../src/boards.ts";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.resetModules();
});

async function start() {
  const host = mountMockHost({ granted: ["storage:app"] });
  unmount = () => host.unmount();
  const { createApp } = await import("@everyos/app-sdk");
  const app: EveryOSApp = await createApp();
  return { host, store: new BoardStore(app, () => 1000) };
}

/** A scene-like JSON text that does not compress away: random ids and coordinates. */
function scene(elements: number): string {
  const random = (seed: number) => ((seed * 1_103_515_245 + 12_345) % 2_147_483_648).toString(36);
  return JSON.stringify({
    type: "excalidraw",
    elements: Array.from({ length: elements }, (_, index) => ({
      id: random(index),
      type: "rectangle",
      x: (index * 7919) % 1000,
      y: (index * 104_729) % 1000,
      text: `Şekil ${random(index * 3)} 図形 "${index}"`,
    })),
  });
}

describe("board storage", () => {
  it("compresses and restores text exactly", async () => {
    const text = scene(50);
    const packed = await pack(text);
    expect(packed).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(packed.length).toBeLessThan(text.length);
    expect(await unpack(packed)).toBe(text);
  });

  it("keeps boards in chunks and removes the ones a smaller version no longer needs", async () => {
    const { host, store } = await start();
    const board = await store.create("  Plans  ");
    expect(board.name).toBe("Plans");
    const big = scene(40_000);
    const saved = await store.save(board.id, big);
    expect(saved.chunks).toBeGreaterThan(1);
    for (let index = 0; index < saved.chunks; index += 1)
      expect((host.storage.get(`board/${board.id}/${index}`) as string).length).toBeLessThanOrEqual(
        CHUNK_CHARS,
      );
    expect(await store.load(board.id)).toBe(big);

    const small = scene(3);
    expect((await store.save(board.id, small)).chunks).toBe(1);
    expect(host.storage.has(`board/${board.id}/1`)).toBe(false);
    expect(await store.load(board.id)).toBe(small);
    expect(await store.list()).toMatchObject([
      { id: board.id, name: "Plans", chunks: 1, updatedAt: 1000 },
    ]);
  });

  it("renames, duplicates and removes boards with their chunks", async () => {
    const { host, store } = await start();
    const board = await store.create("Draft");
    await store.save(board.id, scene(5));
    await store.rename(board.id, "Final");
    const copy = await store.duplicate(board.id, "Final (copy)");
    expect(await store.load(copy.id)).toBe(scene(5));
    expect((await store.list()).map((entry) => entry.name)).toEqual(["Final (copy)", "Final"]);
    await store.remove(board.id);
    expect([...host.storage.keys()].some((key) => key.startsWith(`board/${board.id}/`))).toBe(
      false,
    );
    expect((await store.list()).map((entry) => entry.name)).toEqual(["Final (copy)"]);
    expect(await store.load((await store.create("Empty")).id)).toBeNull();
  });

  it("makes one first board even when asked twice at once", async () => {
    const { store } = await start();
    const [first, second] = await Promise.all([
      store.ensureOne("My board"),
      store.ensureOne("My board"),
    ]);
    expect(first).toEqual(second);
    expect(await store.list()).toHaveLength(1);
  });

  it("refuses boards too large to keep, keeping what was stored", async () => {
    const { host } = await start();
    const { createApp } = await import("@everyos/app-sdk");
    const store = new BoardStore(await createApp(), () => 1000, 20_000);
    const board = await store.create("Huge");
    await store.save(board.id, scene(2));
    // Random text does not compress: well over the limit.
    const noise = [...crypto.getRandomValues(new Uint8Array(40_000))]
      .map((byte) => byte.toString(36))
      .join("");
    await expect(store.save(board.id, JSON.stringify({ noise }))).rejects.toBeInstanceOf(
      BoardTooLargeError,
    );
    expect(await store.load(board.id)).toBe(scene(2));
    expect(host.storage.has(`board/${board.id}/1`)).toBe(false);
  });

  it("stashes a scene while closing and puts it in its board next time", async () => {
    const { host, store } = await start();
    const board = await store.create("Sketch");
    await store.save(board.id, scene(2));
    const latest = scene(400);
    expect(store.stash(board.id, latest)).toBe(true);
    await vi.waitFor(() => expect(host.storage.has("stash")).toBe(true));
    expect(await store.recover()).toBe(board.id);
    expect(await store.load(board.id)).toBe(latest);
    expect([...host.storage.keys()].some((key) => key.startsWith("stash"))).toBe(false);
    // Nothing stashed: nothing to do.
    expect(await store.recover()).toBeNull();
  });

  it("splits text so every piece fits in a storage value, or says it is too large", () => {
    const quotes = '"'.repeat(200_000);
    const pieces = splitForStorage(quotes, MAX_STASH_CHUNKS)!;
    expect(pieces.join("")).toBe(quotes);
    for (const piece of pieces)
      expect(new TextEncoder().encode(JSON.stringify(piece)).length).toBeLessThanOrEqual(
        240 * 1024,
      );
    const emoji = "😀".repeat(100_000);
    const split = splitForStorage(emoji, MAX_STASH_CHUNKS)!;
    expect(split.join("")).toBe(emoji);
    expect(split.every((piece) => !/[\uD800-\uDBFF]$/.test(piece))).toBe(true);
    expect(splitForStorage("x".repeat(60_000 * MAX_STASH_CHUNKS + 1), MAX_STASH_CHUNKS)).toBeNull();
  });
});
