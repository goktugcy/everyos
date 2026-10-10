import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runCapture } from "./exec.ts";

it("never spawns a command with an already aborted signal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "otk-capture-abort-"));
  const marker = join(directory, "spawned");
  const controller = new AbortController();
  controller.abort();
  try {
    await expect(
      runCapture(
        process.execPath,
        ["-e", "require('node:fs').writeFileSync(process.argv[1], 'spawned')", marker],
        { timeoutMs: 1_000, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
