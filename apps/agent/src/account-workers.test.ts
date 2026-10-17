import { randomUUID } from "node:crypto";
import {
  AGENT_OPERATIONS,
  OperationError,
  type Actor,
  type OperationContext,
  type OperationHandlers,
} from "@everyos/agent-protocol";
import { describe, expect, it, vi } from "vitest";
import { AccountWorkers } from "./account-workers.ts";
import type { AgentConfig } from "./config.ts";
import type { LinuxIdentities } from "./linux-identities.ts";

const actor: Extract<Actor, { kind: "user" }> = {
  kind: "user",
  userId: randomUUID(),
  username: "administrator",
  role: "admin",
  sessionId: randomUUID(),
  ip: "127.0.0.1",
};

function wrapped(unlocked: boolean) {
  const identities = {
    resolve: vi.fn(() => {
      throw new OperationError("policy_denied", "LINUX_ACCOUNT_REQUIRED");
    }),
    status: vi.fn(() => ({ privileged: unlocked })),
    requirePrivilege: vi.fn(() =>
      unlocked
        ? Promise.resolve()
        : Promise.reject(new OperationError("policy_denied", "LINUX_SUDO_REQUIRED")),
    ),
  };
  // A handler for every operation that records which ones reached the root agent.
  const reached: string[] = [];
  const handlers = Object.fromEntries(
    Object.keys(AGENT_OPERATIONS).map((op) => [
      op,
      () => {
        reached.push(op);
        return { ok: true };
      },
    ]),
  ) as unknown as OperationHandlers;
  const workers = new AccountWorkers({
    config: {} as AgentConfig,
    identities: identities as unknown as LinuxIdentities,
    files: { roots: [], maxUploadBytes: 1, minFreeBytes: 1 },
    version: "0.0.0",
  });
  const call = (op: string, params: unknown) =>
    (
      workers.wrap(handlers)[op as keyof OperationHandlers] as (
        p: unknown,
        c: OperationContext,
      ) => unknown
    )(params, { actor, signal: new AbortController().signal } as OperationContext);
  return { identities, reached, call };
}

describe("account workers", () => {
  it("reads the reboot state and the disk list without a linked Linux account", async () => {
    const { reached, call } = wrapped(false);
    expect(await call("power.reboot.status", {})).toEqual({ ok: true });
    expect(await call("disks.list", {})).toEqual({ ok: true });
    expect(reached).toEqual(["power.reboot.status", "disks.list"]);
  });

  it("powers off and mounts only with an unlocked sudo account", async () => {
    const locked = wrapped(false);
    locked.identities.resolve.mockImplementation(() => ({}) as never);
    for (const [op, params] of [
      ["power.control", { action: "reboot", delaySeconds: 5 }],
      ["disks.mount", { uuid: "A1B2-C3D4", persistent: true }],
      ["disks.unmount", { uuid: "A1B2-C3D4" }],
    ] as const)
      await expect(Promise.resolve(locked.call(op, params))).rejects.toThrow("LINUX_SUDO_REQUIRED");
    expect(locked.reached).toEqual([]);

    const unlocked = wrapped(true);
    unlocked.identities.resolve.mockImplementation(() => ({}) as never);
    await unlocked.call("power.control", { action: "reboot", delaySeconds: 5 });
    await unlocked.call("disks.mount", { uuid: "A1B2-C3D4", persistent: true });
    expect(unlocked.reached).toEqual(["power.control", "disks.mount"]);
    expect(unlocked.identities.requirePrivilege).toHaveBeenCalledTimes(2);
  });

  it("refuses power and mounts without a linked Linux account", async () => {
    const { reached, call } = wrapped(true);
    await expect(
      Promise.resolve(call("power.control", { action: "shutdown", delaySeconds: 5 })),
    ).rejects.toThrow("LINUX_ACCOUNT_REQUIRED");
    expect(reached).toEqual([]);
  });
});
