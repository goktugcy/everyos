import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runBorg } from "./linux-backup-runner.ts";

// These owned child processes exercise pipe/cancellation limits, without any host backup command.
const invocation = (code: string) => ({
  binary: process.execPath,
  args: ["-e", code],
  cwd: process.cwd(),
  state: process.cwd(),
  passphrase: "Disposable test pipe phrase only",
});

describe("Borg process boundary", () => {
  it("sends the passphrase only through its anonymous pipe", async () => {
    const input = invocation(`
      const value = require('node:fs').readFileSync(3, 'utf8').trimEnd();
      process.stdout.write(JSON.stringify({ digest: require('node:crypto').createHash('sha256').update(value).digest('hex'), exposed: [...Object.values(process.env), ...process.argv].some(item => item.includes(value)) }));
    `);
    const result = await runBorg(input);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual({
      digest: createHash("sha256").update(input.passphrase).digest("hex"),
      exposed: false,
    });
  });
  it("interrupts and reaps its own cancelled child", async () => {
    await expect(
      runBorg({ ...invocation("setInterval(() => {}, 1000)"), signal: AbortSignal.timeout(150) }),
    ).rejects.toThrow("BORG_CANCELLED");
  });
  it("enforces the command timeout", async () => {
    await expect(
      runBorg({ ...invocation("setInterval(() => {}, 1000)"), timeoutMs: 150 }),
    ).rejects.toThrow("BORG_TIMEOUT");
  });
  it("stops a child exceeding the bounded result buffer", async () => {
    await expect(
      runBorg(
        invocation(
          "process.stdout.write('x'.repeat(9 * 1024 * 1024)); setInterval(() => {}, 1000)",
        ),
      ),
    ).rejects.toThrow("BORG_OUTPUT_LIMIT");
  });
});
