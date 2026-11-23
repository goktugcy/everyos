import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_OPERATIONS,
  type Actor,
  type OperationContext,
  type OperationHandlers,
} from "@everyos/agent-protocol";
import { networkRootId, type FileRootKind } from "@everyos/shared";
import { silentLogger } from "@everyos/logger";
import type { AgentConfig } from "./config.ts";
import type { LinuxIdentities } from "./linux-identities.ts";

interface FixtureChild {
  child: ChildProcessWithoutNullStreams;
  output: PassThrough;
  requests: number[];
  rootUpdates: unknown[];
}
const spawned = vi.hoisted(() => [] as FixtureChild[]);
// Only the private-pipe transport is simulated. No OS account, service or mount is created here.
vi.mock("./account-process.ts", async () => {
  const { PassThrough } = await import("node:stream");
  const { EventEmitter } = await import("node:events");
  return {
    spawnAccount: () => {
      const input = new PassThrough(),
        output = new PassThrough(),
        errors = new PassThrough();
      const events = new EventEmitter();
      const child = Object.assign(events, {
        stdin: input,
        stdout: output,
        stderr: errors,
        exitCode: null,
        killed: false,
        kill() {
          this.killed = true;
          output.end();
          errors.end();
          events.emit("close");
          return true;
        },
      });
      const requests: number[] = [],
        rootUpdates: unknown[] = [];
      input.on("data", (data: Buffer) => {
        for (const line of data.toString().trim().split("\n")) {
          const frame = JSON.parse(line) as { id?: number; networkRoots?: unknown };
          if (typeof frame.id === "number") {
            requests.push(frame.id);
            rootUpdates.push(frame.networkRoots);
          }
        }
      });
      const typed = child as unknown as ChildProcessWithoutNullStreams;
      spawned.push({ child: typed, output, requests, rootUpdates });
      return typed;
    },
  };
});
import { AccountWorkers } from "./account-workers.ts";

describe("bounded account-worker cancellation", () => {
  it("preserves normal concurrency and refuses new work until four cancelled native requests drain", async () => {
    const actor: Actor = {
      kind: "user",
      userId: randomUUID(),
      username: "fixture",
      role: "operator",
    };
    const identities = {
      resolve: () => ({ name: "fixture", uid: 1001, gid: 1001, home: "/tmp", shell: "/bin/sh" }),
      status: () => ({ privileged: false }),
    };
    let networkRoots: Array<{
      id: string;
      name: string;
      path: string;
      readOnly: boolean;
      kind: FileRootKind;
    }> = [];
    const workers = new AccountWorkers({
      config: {} as AgentConfig,
      identities: identities as unknown as LinuxIdentities,
      files: { roots: [], maxUploadBytes: 1024, minFreeBytes: 1 },
      version: "fixture",
      networkRoots: () => networkRoots,
    });
    const handlers = Object.fromEntries(
      Object.keys(AGENT_OPERATIONS).map((op) => [
        op,
        () => {
          throw new Error("Root handler must not handle account file reads");
        },
      ]),
    ) as unknown as OperationHandlers;
    const read = workers.wrap(handlers)["files.list"];
    const params = AGENT_OPERATIONS["files.list"].params.parse({
      root: "dev",
      path: "",
      hidden: "false",
      locale: "en",
      systemRoots: false,
    });
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const context = (signal: AbortSignal): OperationContext => ({
      actor,
      signal,
      logger: silentLogger,
    });
    const jobs = controllers.map((c) =>
      Promise.resolve(read(params, context(c.signal))).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      ),
    );
    try {
      await vi.waitFor(() => expect(spawned.at(-1)?.requests).toHaveLength(10));
      const fixture = spawned.at(-1)!;
      for (const c of controllers.slice(0, 4)) c.abort();
      await Promise.all(jobs.slice(0, 4));
      await expect(read(params, context(new AbortController().signal))).rejects.toMatchObject({
        code: "busy",
      });
      for (const id of fixture.requests.slice(0, 4))
        fixture.output.write(
          JSON.stringify({ id, error: { code: "cancelled", message: "Acknowledged" } }) + "\n",
        );
      await new Promise<void>((resolve) => setImmediate(resolve));
      networkRoots = [
        {
          id: networkRootId(randomUUID()),
          name: "Live mount",
          path: "/mnt/everyos-network/fixture/data",
          readOnly: true,
          kind: "network",
        },
      ];
      const resumed = Promise.resolve(read(params, context(new AbortController().signal)));
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(11));
      for (const id of fixture.requests.slice(4))
        fixture.output.write(
          JSON.stringify({ id, result: { root: "dev", path: "", entries: [], truncated: false } }) +
            "\n",
        );
      expect((await Promise.all(jobs)).every((j) => j.error === null)).toBe(true);
      await expect(resumed).resolves.toMatchObject({ entries: [] });
      expect(spawned).toHaveLength(1);
      expect(fixture.rootUpdates.at(-1)).toEqual(networkRoots);
    } finally {
      workers.closeAll();
      spawned.length = 0;
    }
  });
});
