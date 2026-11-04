import type * as FsModule from "node:fs/promises";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ installed: false }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof FsModule>()),
  access: vi.fn((path: string) =>
    state.installed && path === "/usr/bin/everyos-fixture-tool"
      ? Promise.resolve()
      : Promise.reject(new Error("fixture tool absent")),
  ),
}));
import { findExecutable } from "./exec.ts";
it("rediscovers a newly installed executable after a cached miss", async () => {
  expect(await findExecutable("everyos-fixture-tool")).toBeNull();
  state.installed = true;
  expect(await findExecutable("everyos-fixture-tool")).toBeNull();
  expect(await findExecutable("everyos-fixture-tool", { refresh: true })).toBe(
    "/usr/bin/everyos-fixture-tool",
  );
});
