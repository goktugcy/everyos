import { generateTotp } from "@everyos/auth";
import type {
  AdminUserView,
  ApiErrorBody,
  SessionInfo,
  TotpEnrollmentResponse,
  TwoFactorPolicyView,
} from "@everyos/shared";
import { describe, expect, it } from "vitest";
import {
  completeSetup,
  createTestContext,
  json,
  STRONG_PASSWORD,
  TestClient,
  type TestContext,
} from "./test-support.ts";

const errorCode = async (response: Response) => (await json<ApiErrorBody>(response)).error.code;

async function enableTotp(ctx: TestContext, client: TestClient): Promise<string> {
  const { secret } = await json<TotpEnrollmentResponse>(
    await client.post("/api/account/totp/enroll"),
  );
  const enable = await client.post("/api/account/totp/enable", {
    code: generateTotp(secret, ctx.clock.now),
  });
  expect(enable.status).toBe(200);
  return secret;
}

const put = (client: TestClient, body: unknown) =>
  client.request("PUT", "/api/security/two-factor", { body });

async function setup() {
  const ctx = await createTestContext();
  const admin = new TestClient(ctx);
  await completeSetup(ctx, admin);
  const created = await admin.post("/api/users", {
    username: "family",
    displayName: "Family",
    password: STRONG_PASSWORD,
    role: "viewer",
  });
  expect(created.status).toBe(201);
  const family = await json<AdminUserView>(created);
  return { ctx, admin, family };
}

describe("two-factor policy", () => {
  it("defaults to nobody and is for administrators only", async () => {
    const { ctx, admin } = await setup();
    expect(await json<TwoFactorPolicyView>(await admin.get("/api/security/two-factor"))).toEqual({
      required: "nobody",
      pending: [],
    });
    const viewer = new TestClient(ctx, "192.0.2.20");
    await viewer.login("family", STRONG_PASSWORD);
    expect((await viewer.get("/api/security/two-factor")).status).toBe(403);
    expect((await put(viewer, { required: "nobody" })).status).toBe(403);
    expect((await put(admin, { required: "some" })).status).toBe(400);
  });

  it("refuses to require it from the administrator's own role before they have it", async () => {
    const { ctx, admin } = await setup();
    for (const required of ["admins", "everyone"]) {
      const response = await put(admin, { required });
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe("TWO_FACTOR_SELF_FIRST");
    }
    await enableTotp(ctx, admin);
    const view = await json<TwoFactorPolicyView>(await put(admin, { required: "admins" }));
    expect(view).toEqual({ required: "admins", pending: [] });
    const audit = ctx.db.get<{ details: string }>(
      "SELECT details FROM audit_events WHERE action = 'security.two-factor'",
    );
    expect(JSON.parse(audit!.details)).toEqual({ from: "nobody", to: "admins" });
  });

  it("keeps a covered account on the setup until it has a second factor", async () => {
    const { ctx, admin, family } = await setup();
    await enableTotp(ctx, admin);
    const view = await json<TwoFactorPolicyView>(await put(admin, { required: "everyone" }));
    expect(view.pending).toEqual([{ id: family.id, username: "family", displayName: "Family" }]);

    const client = new TestClient(ctx, "192.0.2.30");
    await client.login("family", STRONG_PASSWORD);
    const session = await json<SessionInfo>(await client.get("/api/auth/session"));
    expect(session.twoFactorSetupRequired).toBe(true);
    // Everything but the setup, the session and the sign-in screens is refused.
    for (const path of [
      "/api/files/list?root=home&path=",
      "/api/system/info",
      "/api/notifications",
    ]) {
      const response = await client.get(path);
      expect(response.status, path).toBe(403);
      expect(await errorCode(response)).toBe("TWO_FACTOR_REQUIRED");
    }
    expect((await client.get("/api/preferences")).status).toBe(200);
    expect((await client.get("/api/bootstrap")).status).toBe(200);

    const secret = await enableTotp(ctx, client);
    const after = await json<SessionInfo>(await client.get("/api/auth/session"));
    expect(after.twoFactorSetupRequired).toBe(false);
    expect((await client.get("/api/system/info")).status).toBe(200);
    expect(
      (await json<TwoFactorPolicyView>(await admin.get("/api/security/two-factor"))).pending,
    ).toEqual([]);

    // A covered account cannot turn it off again.
    ctx.clock.now += 30_000;
    const disable = await client.post("/api/account/totp/disable", {
      password: STRONG_PASSWORD,
      code: generateTotp(secret, ctx.clock.now),
    });
    expect(disable.status).toBe(409);
    expect(await errorCode(disable)).toBe("TWO_FACTOR_ENFORCED");

    // An administrator's reset sends it back to the setup.
    expect((await admin.post(`/api/users/${family.id}/totp/reset`)).status).toBe(204);
    expect((await client.get("/api/system/info")).status).toBe(403);
  });

  it("covers only administrators under the admins policy", async () => {
    const { ctx, admin } = await setup();
    await enableTotp(ctx, admin);
    await put(admin, { required: "admins" });
    const viewer = new TestClient(ctx, "192.0.2.40");
    await viewer.login("family", STRONG_PASSWORD);
    expect(
      (await json<SessionInfo>(await viewer.get("/api/auth/session"))).twoFactorSetupRequired,
    ).toBe(false);
    expect((await viewer.get("/api/system/info")).status).toBe(200);
  });
});
