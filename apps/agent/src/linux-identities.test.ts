import { mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
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
