import { statSync } from "node:fs";
import { userInfo } from "node:os";
import { silentLogger } from "@everyos/logger";
import type { Actor } from "@everyos/agent-protocol";
import { describe, expect, it } from "vitest";
import { TerminalManager } from "./terminal.ts";

const python = ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"].find(
  (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
);

const me: Actor = { kind: "user", userId: "u1", username: "admin", role: "admin" };
const other: Actor = { kind: "user", userId: "u2", username: "op", role: "operator" };

async function collect(
  manager: TerminalManager,
  sessionId: string,
  script: (send: (text: string) => void) => Promise<void>,
): Promise<{ output: string; code: number | null; started: boolean }> {
  const controller = new AbortController();
  let output = "";
  let code: number | null = null;
  let started = false;
  const reader = (async () => {
    for await (const event of manager.open(
      { sessionId, cols: 100, rows: 30 },
      me,
      controller.signal,
    )) {
      if (event.type === "started") started = true;
      if (event.type === "output") output += Buffer.from(event.data, "base64").toString("utf8");
      if (event.type === "exit") code = event.code;
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await script((text) => manager.input(sessionId, Buffer.from(text).toString("base64"), me));
  await Promise.race([
    reader,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
  ]);
  return { output, code, started };
}

describe("terminal manager", () => {
  it("is disabled until an account is configured, and refuses root by default", () => {
    expect(new TerminalManager({ config: null, logger: silentLogger }).status()).toEqual({
      enabled: false,
      reason: "not-configured",
    });
    const root = new TerminalManager({
      config: { user: "root", allowRoot: false, python: python ?? "/usr/bin/python3" },
      logger: silentLogger,
    });
    expect(root.status()).toEqual({ enabled: false, reason: "root-refused" });
    const missing = new TerminalManager({
      config: {
        user: "everyos-no-such-user",
        allowRoot: false,
        python: python ?? "/usr/bin/python3",
      },
      logger: silentLogger,
    });
    expect(missing.status()).toEqual({ enabled: false, reason: "user-missing" });
  });

  it.skipIf(!python || process.getuid?.() === 0)(
    "runs a shell in a pseudo-terminal with resize, ownership and exit codes",
    async () => {
      const manager = new TerminalManager({
        config: { user: userInfo().username, shell: "/bin/sh", allowRoot: false, python: python! },
        logger: silentLogger,
      });
      expect(manager.status()).toMatchObject({ enabled: true, shell: "/bin/sh" });
      const sessionId = "6c4b7c2e-0a8e-4f43-9c66-2f8f1f6f6d01";
      const result = await collect(manager, sessionId, async (send) => {
        send("echo everyos-$((40+2))\n");
        await new Promise((resolve) => setTimeout(resolve, 200));
        // Someone else cannot type into this session.
        expect(() =>
          manager.input(sessionId, Buffer.from("echo x\n").toString("base64"), other),
        ).toThrow(/another user/);
        manager.resize(sessionId, 120, 40, me);
        await new Promise((resolve) => setTimeout(resolve, 200));
        send("stty size\n");
        await new Promise((resolve) => setTimeout(resolve, 200));
        send("exit 3\n");
      });
      expect(result.started).toBe(true);
      expect(result.output).toContain("everyos-42");
      expect(result.output).toContain("40 120");
      expect(result.code).toBe(3);
      expect(() => manager.input(sessionId, "", me)).toThrow(/No such terminal/);
    },
    15_000,
  );

  it.skipIf(!python || process.getuid?.() === 0)(
    "kills the shell when the session is closed",
    async () => {
      const manager = new TerminalManager({
        config: { user: userInfo().username, shell: "/bin/sh", allowRoot: false, python: python! },
        logger: silentLogger,
      });
      const sessionId = "6c4b7c2e-0a8e-4f43-9c66-2f8f1f6f6d02";
      const result = await collect(manager, sessionId, async (send) => {
        send("sleep 30\n");
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(manager.close(sessionId)).toBe(true);
      });
      expect(result.code).not.toBe(0);
    },
    15_000,
  );
});
