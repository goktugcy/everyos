import {
  mkdtempSync,
  readFileSync,
  rmSync,
  chmodSync,
  statSync,
  writeFileSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@everyos/agent-protocol";
import type { LinuxAccount } from "@everyos/shared";
import { LinuxIdentities } from "./linux-identities.ts";

const owned: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});
const user = (): Extract<Actor, { kind: "user" }> => ({
  kind: "user",
  userId: randomUUID(),
  username: "administrator",
  role: "admin",
  sessionId: randomUUID(),
  ip: "127.0.0.1",
});
const account: LinuxAccount = {
  name: "alice",
  uid: 1000,
  gid: 1000,
  home: "/home/alice",
  shell: "/bin/bash",
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "everyos-linux-identities-"));
  owned.push(root);
  let accounts = [account];
  const authenticate = vi.fn((_account: LinuxAccount, password: string) =>
    Promise.resolve(password === "linux-private-password"),
  );
  const authorize = vi.fn((_account: LinuxAccount, password?: string) =>
    Promise.resolve(password === "linux-private-password"),
  );
  const onChange = vi.fn();
  const options = {
    path: join(root, "bindings.json"),
    onChange,
    accounts: () => accounts,
    authenticate,
    authorize,
    policyAllows: vi.fn(() => Promise.resolve(true)),
  };
  return {
    identities: new LinuxIdentities(options),
    options,
    onChange,
    authorize,
    replace: (next: LinuxAccount[]) => {
      accounts = next;
    },
  };
}

describe("Linux identity boundary", () => {
  it("requires OS authentication, persists only a UID-pinned association and rejects replaced accounts", async () => {
    const f = fixture();
    const actor = user();
    expect(() => f.identities.resolve(actor)).toThrow("LINUX_ACCOUNT_REQUIRED");
    await expect(f.identities.bind(actor.userId, account.name, "wrong")).rejects.toThrow(
      "LINUX_AUTH_FAILED",
    );
    await f.identities.bind(actor.userId, account.name, "linux-private-password");
    expect(f.identities.resolve(actor)).toEqual(account);
    expect(readFileSync(f.options.path, "utf8")).not.toContain("password");
    expect(new LinuxIdentities(f.options).resolve(actor)).toEqual(account);
    f.replace([{ ...account, uid: 1001 }]);
    expect(() => f.identities.resolve(actor)).toThrow("LINUX_ACCOUNT_REQUIRED");
  });

  it("requires actual sudo authorization, scopes grants to one session and expires them", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const actor = user();
    await f.identities.bind(actor.userId, account.name, "linux-private-password");
    await expect(f.identities.requirePrivilege(actor)).rejects.toThrow("LINUX_SUDO_REQUIRED");
    f.authorize.mockResolvedValueOnce(false);
    await expect(f.identities.unlock(actor, "linux-private-password")).rejects.toThrow(
      "LINUX_SUDO_REQUIRED",
    );
    await f.identities.unlock(actor, "linux-private-password");
    await expect(f.identities.requirePrivilege(actor)).resolves.toBeUndefined();
    const other = { ...actor, sessionId: randomUUID() };
    await expect(f.identities.requirePrivilege(other)).rejects.toThrow("LINUX_SUDO_REQUIRED");
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await expect(f.identities.requirePrivilege(actor)).rejects.toThrow("LINUX_SUDO_REQUIRED");
  });

  it("revokes grants and live processes when the link changes or is removed", async () => {
    const f = fixture();
    const actor = user();
    await f.identities.bind(actor.userId, account.name, "linux-private-password");
    await f.identities.unlock(actor, "linux-private-password");
    await f.identities.bind(actor.userId, account.name, "linux-private-password");
    expect(f.identities.status(actor).privilegedUntil).toBeNull();
    await f.identities.unbind(actor.userId);
    expect(f.onChange).toHaveBeenCalledTimes(3);
    expect(f.identities.status(actor).account).toBeNull();
  });

  it("refuses an identity store writable by another account", () => {
    const f = fixture();
    chmodSync(join(f.options.path, ".."), 0o777);
    expect(() => new LinuxIdentities(f.options)).toThrow("Unsafe Linux identity store");
  });
});

describe("persistent Linux privilege durations", () => {
  it("keeps a timed grant across sessions and agent restarts and expires at its chosen boundary", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const actor = user();
    await f.identities.bind(actor.userId, account.name, "linux-private-password");
    const result = await f.identities.unlock(actor, "linux-private-password", "15m");
    expect(result).toMatchObject({
      privileged: true,
      privilegedUntil: Date.now() + 15 * 60_000,
      privilegeScope: "account",
      privilegeDuration: "15m",
    });
    const restarted = new LinuxIdentities(f.options);
    const nextSession = { ...actor, sessionId: randomUUID() };
    await expect(restarted.requirePrivilege(nextSession)).resolves.toBeUndefined();
    vi.advanceTimersByTime(15 * 60_000);
    expect(restarted.status(nextSession)).toMatchObject({
      privileged: false,
      privilegedUntil: null,
      privilegeDuration: "15m",
    });
    await expect(restarted.requirePrivilege(nextSession)).rejects.toThrow("LINUX_SUDO_REQUIRED");
  });

  it("keeps indefinite grants without storing credentials and distinguishes session lock from explicit revocation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const actor = user();
    await f.identities.bind(actor.userId, account.name, "linux-private-password");
    await f.identities.unlock(actor, "linux-private-password", "permanent");
    vi.advanceTimersByTime(400 * 24 * 60 * 60_000);
    f.identities.lock(actor, "session");
    const restarted = new LinuxIdentities(f.options);
    const next = { ...actor, sessionId: randomUUID() };
    expect(restarted.status(next)).toMatchObject({
      privileged: true,
      privilegedUntil: null,
      privilegeDuration: "permanent",
      privilegeScope: "account",
    });
    await expect(restarted.requirePrivilege(next)).resolves.toBeUndefined();
    const path = join(f.options.path, "..", "grants.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("password");
    expect(JSON.parse(readFileSync(f.options.path, "utf8"))).toEqual([
      { userId: actor.userId, account: "alice", uid: 1000 },
    ]);
    restarted.lock(next, "account");
    expect(new LinuxIdentities(f.options).status(next).privileged).toBe(false);
  });

  it("does not transfer a grant to another user sharing the same Linux account", async () => {
    const f = fixture(),
      first = user(),
      second = user();
    await f.identities.bind(first.userId, account.name, "linux-private-password");
    await f.identities.bind(second.userId, account.name, "linux-private-password");
    await f.identities.unlock(first, "linux-private-password", "1w");
    expect(f.identities.status(second).privileged).toBe(false);
    await expect(f.identities.requirePrivilege(second)).rejects.toThrow("LINUX_SUDO_REQUIRED");
    await f.identities.bind(second.userId, account.name, "linux-private-password");
    expect(new LinuxIdentities(f.options).status(first).privileged).toBe(true);
    await f.identities.bind(first.userId, account.name, "linux-private-password");
    expect(new LinuxIdentities(f.options).status(first).privileged).toBe(false);
  });

  it("revokes a saved grant when sudo policy or the linked UID changes", async () => {
    const f = fixture(),
      actor = user();
    await f.identities.bind(actor.userId, account.name, "linux-private-password");
    await f.identities.unlock(actor, "linux-private-password", "permanent");
    f.options.policyAllows.mockResolvedValue(false);
    await expect(f.identities.requirePrivilege(actor)).rejects.toThrow("LINUX_SUDO_REQUIRED");
    f.options.policyAllows.mockResolvedValue(true);
    expect(new LinuxIdentities(f.options).status(actor).privileged).toBe(false);
    await f.identities.unlock(actor, "linux-private-password", "permanent");
    f.replace([{ ...account, uid: 1001 }]);
    expect(f.identities.status(actor).privileged).toBe(false);
    f.replace([account]);
    expect(new LinuxIdentities(f.options).status(actor).privileged).toBe(false);
  });

  it("invalidates persisted grants after an older agent rewrites bindings and rejects unsafe grant files", async () => {
    const f = fixture(),
      actor = user();
    await f.identities.bind(actor.userId, account.name, "linux-private-password");
    await f.identities.unlock(actor, "linux-private-password", "1mo");
    const contents = readFileSync(f.options.path);
    writeFileSync(f.options.path + ".replacement", contents, { mode: 0o600 });
    renameSync(f.options.path + ".replacement", f.options.path);
    expect(new LinuxIdentities(f.options).status(actor).privileged).toBe(false);
    const path = join(f.options.path, "..", "grants.json");
    chmodSync(path, 0o644);
    expect(() => new LinuxIdentities(f.options)).toThrow("Unsafe Linux identity store");
    rmSync(path);
    symlinkSync(f.options.path, path);
    expect(() => new LinuxIdentities(f.options)).toThrow("Unsafe Linux identity store");
  });

  it("does not let in-flight authorization recreate a grant after manual revocation", async () => {
    const f = fixture(),
      actor = user();
    await f.identities.bind(actor.userId, account.name, "linux-private-password");
    let release: (value: boolean) => void = () => undefined;
    const held = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    f.authorize.mockReturnValueOnce(held);
    const pending = f.identities.unlock(actor, "linux-private-password", "permanent");
    await vi.waitFor(() => expect(f.authorize).toHaveBeenCalled());
    f.identities.lock(actor, "account");
    release(true);
    await expect(pending).rejects.toThrow("LINUX_ACCOUNT_REQUIRED");
    expect(new LinuxIdentities(f.options).status(actor).privileged).toBe(false);
  });
});
