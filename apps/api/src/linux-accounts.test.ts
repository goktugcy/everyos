import type { LinuxAccountStatus } from "@everyos/shared";
import { expect, it } from "vitest";
import { json, withRoles } from "./test-support.ts";

const status: LinuxAccountStatus = {
  account: { name: "alice", uid: 1000, gid: 1000, home: "/home/alice", shell: "/bin/bash" },
  privileged: true,
  privilegedUntil: null,
  privilegeDuration: "permanent",
  privilegeScope: "account",
};

it("validates durations, scopes the grant to the caller and audits no Linux password", async () => {
  const { ctx, admin } = await withRoles();
  ctx.agent.handlers.set("identity.unlock", () => status);
  const before = ctx.agent.calls.length;
  expect(
    (
      await admin.post("/api/account/linux/unlock", {
        linuxPassword: "linux-test-password",
        duration: "arbitrary",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await admin.post("/api/account/linux/unlock", {
        linuxPassword: "linux-test-password",
        duration: "permanent",
        userId: "other-user",
      })
    ).status,
  ).toBe(400);
  expect(ctx.agent.calls).toHaveLength(before);
  const response = await admin.post("/api/account/linux/unlock", {
    linuxPassword: "linux-test-password",
    duration: "permanent",
  });
  expect(response.status).toBe(200);
  expect(await json(response)).toEqual(status);
  const call = ctx.agent.calls.find((c) => c.op === "identity.unlock");
  expect(call?.params).toEqual({ linuxPassword: "linux-test-password", duration: "permanent" });
  expect(call?.actor).toMatchObject({ kind: "user", username: "admin" });
  const audit = ctx.db.all(
    "SELECT details FROM audit_events WHERE action = 'account.linux.unlock'",
  );
  expect(JSON.stringify(audit)).toContain("permanent");
  expect(JSON.stringify(audit)).not.toContain("linux-test-password");
});

it("distinguishes signing out from explicitly revoking account-wide privileges", async () => {
  const { ctx, admin } = await withRoles();
  ctx.services.config.mode = "production";
  ctx.agent.handlers.set("identity.lock", () => null);
  expect((await admin.post("/api/account/linux/lock", { scope: "session" })).status).toBe(400);
  expect((await admin.get("/api/account/linux?userId=other-user")).status).toBe(400);
  expect(ctx.agent.calls.filter((c) => c.op === "identity.lock")).toHaveLength(0);
  expect((await admin.post("/api/account/linux/lock", {})).status).toBe(204);
  expect(ctx.agent.calls.filter((c) => c.op === "identity.lock").at(-1)?.params).toEqual({
    scope: "account",
  });
  expect((await admin.post("/api/auth/logout", {})).status).toBe(204);
  expect(ctx.agent.calls.filter((c) => c.op === "identity.lock").at(-1)?.params).toEqual({
    scope: "session",
  });
});
