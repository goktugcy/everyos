import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTotp } from "@everyos/auth";
import type {
  AdminUserView,
  ApiErrorBody,
  AuditPage,
  BootstrapResponse,
  LoginResponse,
  RecoveryCodesResponse,
  SessionInfo,
  SessionSummary,
  TotpEnrollmentResponse,
} from "@everyos/shared";
import { describe, expect, it } from "vitest";
import {
  completeSetup,
  createTestContext,
  json,
  STRONG_PASSWORD,
  TEST_ORIGIN,
  TestClient,
  type TestContext,
} from "./test-support.ts";

const errorCode = async (response: Response) => (await json<ApiErrorBody>(response)).error.code;

async function setupWithAdmin(): Promise<{
  ctx: TestContext;
  admin: TestClient;
  session: SessionInfo;
}> {
  const ctx = await createTestContext();
  const admin = new TestClient(ctx);
  const session = await completeSetup(ctx, admin);
  return { ctx, admin, session };
}

async function createUser(
  admin: TestClient,
  username: string,
  role: "admin" | "operator" | "viewer",
) {
  const response = await admin.post("/api/users", {
    username,
    displayName: username,
    password: STRONG_PASSWORD,
    role,
  });
  expect(response.status).toBe(201);
  return json<AdminUserView>(response);
}

describe("first-run setup", () => {
  it("reports that setup is required and writes a private setup token", async () => {
    const ctx = await createTestContext();
    const client = new TestClient(ctx);
    const bootstrap = await json<BootstrapResponse>(await client.get("/api/bootstrap"));
    expect(bootstrap).toMatchObject({
      setupRequired: true,
      defaultLocale: "en",
      transport: { secure: false, loopback: true },
    });
    expect(ctx.readSetupToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("rejects a wrong setup token and rate-limits guessing", async () => {
    const ctx = await createTestContext();
    const client = new TestClient(ctx, "192.0.2.10");
    const attempt = () =>
      client.post("/api/setup", {
        setupToken: "wrong",
        username: "admin",
        displayName: "A",
        password: STRONG_PASSWORD,
        locale: "tr",
      });
    for (let i = 0; i < 5; i++) {
      const response = await attempt();
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe("SETUP_TOKEN_INVALID");
    }
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("enforces the password policy", async () => {
    const ctx = await createTestContext();
    const response = await new TestClient(ctx).post("/api/setup", {
      setupToken: ctx.readSetupToken(),
      username: "admin",
      displayName: "A",
      password: "1234567890",
      locale: "tr",
    });
    expect(response.status).toBe(400);
    const body = await json<ApiErrorBody>(response);
    expect(body.error.code).toBe("AUTH_PASSWORD_POLICY");
    expect(body.error.details).toEqual({ violations: ["too-common"] });
  });

  it("creates the administrator once, signs in and closes the endpoint", async () => {
    const ctx = await createTestContext();
    const client = new TestClient(ctx);
    const response = await client.post("/api/setup", {
      setupToken: ctx.readSetupToken(),
      username: "Admin",
      displayName: "Göktuğ",
      password: STRONG_PASSWORD,
      locale: "en",
    });
    expect(response.status).toBe(201);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^everyos_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).not.toMatch(/Secure/i);
    const session = await json<SessionInfo>(response);
    expect(session.user).toMatchObject({
      username: "admin",
      displayName: "Göktuğ",
      role: "admin",
      locale: "en",
    });
    expect(session.permissions).toContain("users:manage");
    expect(existsSync(ctx.config.paths.setupTokenFile)).toBe(false);

    const bootstrap = await json<BootstrapResponse>(await client.get("/api/bootstrap"));
    expect(bootstrap.setupRequired).toBe(false);
    const again = await new TestClient(ctx).post("/api/setup", {
      setupToken: "anything",
      username: "evil",
      displayName: "E",
      password: STRONG_PASSWORD,
      locale: "tr",
    });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("SETUP_ALREADY_COMPLETED");
  });
});

describe("login and sessions", () => {
  it("returns the same error for unknown users and wrong passwords", async () => {
    const { ctx } = await setupWithAdmin();
    const client = new TestClient(ctx);
    const unknown = await client.login("nobody", STRONG_PASSWORD);
    const wrong = await client.login("admin", "wrong-password-123");
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await errorCode(unknown)).toBe("AUTH_INVALID_CREDENTIALS");
    expect(await errorCode(wrong)).toBe("AUTH_INVALID_CREDENTIALS");
  });

  it("creates a session that exposes the user, permissions and CSRF token", async () => {
    const { ctx } = await setupWithAdmin();
    const client = new TestClient(ctx);
    const response = await client.login("ADMIN", STRONG_PASSWORD);
    expect(response.status).toBe(200);
    const body = await json<LoginResponse>(response);
    expect(body.status).toBe("authenticated");
    const session = await json<SessionInfo>(await client.get("/api/auth/session"));
    expect(session.user.username).toBe("admin");
    expect(session.csrfToken).toBe(client.csrfToken);
  });

  it("locks an account temporarily after repeated failures", async () => {
    const { ctx } = await setupWithAdmin();
    const client = new TestClient(ctx, "192.0.2.20");
    for (let i = 0; i < 5; i++)
      expect((await client.login("admin", "wrong-password-xyz")).status).toBe(401);
    const locked = await client.login("admin", STRONG_PASSWORD);
    expect(locked.status).toBe(429);
    expect(await errorCode(locked)).toBe("RATE_LIMITED");
    ctx.clock.now += 61_000;
    expect((await client.login("admin", STRONG_PASSWORD)).status).toBe(200);
  });

  it("expires idle sessions", async () => {
    const { ctx, admin } = await setupWithAdmin();
    expect((await admin.get("/api/auth/session")).status).toBe(200);
    ctx.clock.now += ctx.config.security.sessionIdleMs + 1;
    expect((await admin.get("/api/auth/session")).status).toBe(401);
  });

  it("logs out and invalidates the session server-side", async () => {
    const { admin } = await setupWithAdmin();
    const cookieBefore = new Map(admin.cookies);
    expect((await admin.post("/api/auth/logout")).status).toBe(204);
    // Replaying the old cookie must not work.
    for (const [name, value] of cookieBefore) admin.cookies.set(name, value);
    expect((await admin.get("/api/auth/session")).status).toBe(401);
  });

  it("lists and revokes other sessions", async () => {
    const { ctx, admin } = await setupWithAdmin();
    const laptop = new TestClient(ctx, "192.0.2.30");
    await laptop.login("admin", STRONG_PASSWORD);
    const { sessions } = await json<{ sessions: SessionSummary[] }>(
      await admin.get("/api/auth/sessions"),
    );
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s) => !s.current)!;
    expect(other.ip).toBe("192.0.2.30");
    expect((await admin.delete(`/api/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await laptop.get("/api/auth/session")).status).toBe(401);
    expect((await admin.get("/api/auth/session")).status).toBe(200);
  });
});

describe("CSRF protection", () => {
  it("requires the session CSRF token on state-changing requests", async () => {
    const { admin } = await setupWithAdmin();
    const token = admin.csrfToken;
    admin.csrfToken = null;
    const response = await admin.post("/api/auth/logout");
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("CSRF_FAILED");
    admin.csrfToken = token;
    expect((await admin.post("/api/auth/logout")).status).toBe(204);
  });

  it("rejects foreign origins and cross-site fetch metadata", async () => {
    const { admin } = await setupWithAdmin();
    const foreign = await admin.post("/api/auth/logout", undefined, {
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
    const crossSite = await admin.post("/api/auth/logout", undefined, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    const login = await new TestClient(await createTestContext()).post(
      "/api/auth/login",
      { username: "a", password: "b" },
      { headers: { origin: "https://evil.example" } },
    );
    expect(login.status).toBe(403);
  });

  it("accepts configured public origins", async () => {
    const ctx = await createTestContext({
      configure: (config) => (config.server.publicOrigins = ["https://everyos.tail.ts.net"]),
    });
    const client = new TestClient(ctx);
    await completeSetup(ctx, client);
    const response = await client.post("/api/auth/logout", undefined, {
      headers: { origin: "https://everyos.tail.ts.net" },
    });
    expect(response.status).toBe(204);
  });
});

describe("authorization", () => {
  it("enforces role permissions on the server", async () => {
    const { ctx, admin } = await setupWithAdmin();
    await createUser(admin, "izleyici", "viewer");
    const viewer = new TestClient(ctx, "192.0.2.40");
    expect((await viewer.login("izleyici", STRONG_PASSWORD)).status).toBe(200);
    expect((await viewer.get("/api/users")).status).toBe(403);
    expect((await viewer.get("/api/audit")).status).toBe(403);
    expect((await viewer.get("/api/system/info")).status).toBe(200);
    expect((await new TestClient(ctx).get("/api/system/info")).status).toBe(401);
  });

  it("forwards the authenticated identity to the agent", async () => {
    const { ctx, admin, session } = await setupWithAdmin();
    await admin.get("/api/system/info");
    expect(ctx.agent.calls.at(-1)).toEqual({
      op: "system.info",
      params: {},
      actor: {
        kind: "user",
        userId: session.user.id,
        username: "admin",
        role: "admin",
        sessionId: session.session.id,
        ip: "127.0.0.1",
      },
    });
  });

  it("reports an unavailable agent instead of failing silently", async () => {
    const { ctx, admin } = await setupWithAdmin();
    ctx.agent.state = "disconnected";
    const response = await admin.get("/api/system/info");
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("AGENT_UNAVAILABLE");
    const health = await json<{ status: string; checks: { agent: string } }>(
      await admin.get("/api/health"),
    );
    expect(health).toMatchObject({ status: "degraded", checks: { agent: "unavailable" } });
  });

  it("applies role changes and account disabling immediately", async () => {
    const { ctx, admin } = await setupWithAdmin();
    const operator = await createUser(admin, "operator1", "operator");
    const client = new TestClient(ctx, "192.0.2.50");
    await client.login("operator1", STRONG_PASSWORD);
    expect((await client.get("/api/system/info")).status).toBe(200);

    expect((await admin.patch(`/api/users/${operator.id}`, { disabled: true })).status).toBe(200);
    expect((await client.get("/api/auth/session")).status).toBe(401);
    const login = await client.login("operator1", STRONG_PASSWORD);
    expect(login.status).toBe(403);
    expect(await errorCode(login)).toBe("AUTH_ACCOUNT_DISABLED");
  });

  it("protects administrators from locking themselves out", async () => {
    const { admin, session } = await setupWithAdmin();
    const demote = await admin.patch(`/api/users/${session.user.id}`, { role: "viewer" });
    expect(await errorCode(demote)).toBe("USER_CANNOT_MODIFY_SELF");
    expect(await errorCode(await admin.delete(`/api/users/${session.user.id}`))).toBe(
      "USER_CANNOT_MODIFY_SELF",
    );
    const conflict = await admin.post("/api/users", {
      username: "admin",
      displayName: "x",
      password: STRONG_PASSWORD,
      role: "viewer",
    });
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("USER_USERNAME_TAKEN");
  });

  it("resets passwords and signs the user out everywhere", async () => {
    const { ctx, admin } = await setupWithAdmin();
    const user = await createUser(admin, "kullanici", "viewer");
    const client = new TestClient(ctx, "192.0.2.60");
    await client.login("kullanici", STRONG_PASSWORD);
    expect(
      (await admin.post(`/api/users/${user.id}/password`, { newPassword: "yeni-parola-cumlesi-7" }))
        .status,
    ).toBe(204);
    expect((await client.get("/api/auth/session")).status).toBe(401);
    expect((await client.login("kullanici", "yeni-parola-cumlesi-7")).status).toBe(200);
  });
});

describe("account security", () => {
  it("changes the password after verifying the current one and revokes other sessions", async () => {
    const { ctx, admin } = await setupWithAdmin();
    const other = new TestClient(ctx, "192.0.2.70");
    await other.login("admin", STRONG_PASSWORD);
    const wrong = await admin.post("/api/account/password", {
      currentPassword: "not-the-password",
      newPassword: "baska-guclu-parola-9",
    });
    expect(await errorCode(wrong)).toBe("AUTH_CURRENT_PASSWORD_INVALID");
    const ok = await admin.post("/api/account/password", {
      currentPassword: STRONG_PASSWORD,
      newPassword: "baska-guclu-parola-9",
    });
    expect(ok.status).toBe(204);
    expect((await other.get("/api/auth/session")).status).toBe(401);
    expect((await admin.get("/api/auth/session")).status).toBe(200);
  });

  it("updates display name and language", async () => {
    const { admin } = await setupWithAdmin();
    const response = await admin.patch("/api/account", { locale: "en", displayName: "Göktuğ C." });
    expect(await json(response)).toMatchObject({ locale: "en", displayName: "Göktuğ C." });
  });

  it("enrolls TOTP, requires it at login, blocks replay and accepts recovery codes once", async () => {
    const { ctx, admin } = await setupWithAdmin();
    const enrollment = await json<TotpEnrollmentResponse>(
      await admin.post("/api/account/totp/enroll"),
    );
    expect(enrollment.otpauthUri).toContain("otpauth://totp/EveryOS:admin%40");

    const badEnable = await admin.post("/api/account/totp/enable", { code: "000000" });
    expect(badEnable.status).toBe(400);
    const enable = await admin.post("/api/account/totp/enable", {
      code: generateTotp(enrollment.secret, ctx.clock.now),
    });
    expect(enable.status).toBe(200);
    const { recoveryCodes } = await json<RecoveryCodesResponse>(enable);
    expect(recoveryCodes).toHaveLength(10);

    // The secret is stored encrypted, never in plain text.
    const stored = ctx.db.get<{ totp_secret_enc: string }>("SELECT totp_secret_enc FROM users")!;
    expect(stored.totp_secret_enc.startsWith("v1.")).toBe(true);
    expect(stored.totp_secret_enc).not.toContain(enrollment.secret);

    const client = new TestClient(ctx, "192.0.2.80");
    const first = await json<LoginResponse>(await client.login("admin", STRONG_PASSWORD));
    expect(first.status).toBe("totp_required");
    if (first.status !== "totp_required") return;
    expect((await client.get("/api/auth/session")).status).toBe(401);

    const wrong = await client.post("/api/auth/login/totp", {
      challengeId: first.challengeId,
      code: "123456",
    });
    expect(await errorCode(wrong)).toBe("AUTH_TOTP_INVALID");

    ctx.clock.now += 30_000;
    const code = generateTotp(enrollment.secret, ctx.clock.now);
    const ok = await client.post("/api/auth/login/totp", { challengeId: first.challengeId, code });
    expect(ok.status).toBe(200);
    expect((await client.get("/api/auth/session")).status).toBe(200);

    // Same code, new login attempt: rejected as a replay.
    const replayClient = new TestClient(ctx, "192.0.2.81");
    const second = await json<LoginResponse>(await replayClient.login("admin", STRONG_PASSWORD));
    if (second.status !== "totp_required") throw new Error("expected totp challenge");
    expect(
      await errorCode(
        await replayClient.post("/api/auth/login/totp", { challengeId: second.challengeId, code }),
      ),
    ).toBe("AUTH_TOTP_INVALID");
    const recovery = await replayClient.post("/api/auth/login/totp", {
      challengeId: second.challengeId,
      recoveryCode: recoveryCodes[0],
    });
    expect(recovery.status).toBe(200);

    const third = await json<LoginResponse>(
      await new TestClient(ctx, "192.0.2.82").login("admin", STRONG_PASSWORD),
    );
    if (third.status !== "totp_required") throw new Error("expected totp challenge");
    const reused = await new TestClient(ctx, "192.0.2.82").post("/api/auth/login/totp", {
      challengeId: third.challengeId,
      recoveryCode: recoveryCodes[0],
    });
    expect(await errorCode(reused)).toBe("AUTH_TOTP_INVALID");
  });

  it("binds TOTP challenges to the client address", async () => {
    const { ctx, admin } = await setupWithAdmin();
    const enrollment = await json<TotpEnrollmentResponse>(
      await admin.post("/api/account/totp/enroll"),
    );
    await admin.post("/api/account/totp/enable", {
      code: generateTotp(enrollment.secret, ctx.clock.now),
    });
    const challenge = await json<LoginResponse>(
      await new TestClient(ctx, "192.0.2.90").login("admin", STRONG_PASSWORD),
    );
    if (challenge.status !== "totp_required") throw new Error("expected totp challenge");
    ctx.clock.now += 30_000;
    const stolen = await new TestClient(ctx, "198.51.100.1").post("/api/auth/login/totp", {
      challengeId: challenge.challengeId,
      code: generateTotp(enrollment.secret, ctx.clock.now),
    });
    expect(await errorCode(stolen)).toBe("AUTH_CHALLENGE_EXPIRED");
  });

  it("disables TOTP only with password and a valid code", async () => {
    const { ctx, admin } = await setupWithAdmin();
    const enrollment = await json<TotpEnrollmentResponse>(
      await admin.post("/api/account/totp/enroll"),
    );
    await admin.post("/api/account/totp/enable", {
      code: generateTotp(enrollment.secret, ctx.clock.now),
    });
    ctx.clock.now += 30_000;
    const noPassword = await admin.post("/api/account/totp/disable", {
      password: "nope-nope-nope",
      code: generateTotp(enrollment.secret, ctx.clock.now),
    });
    expect(await errorCode(noPassword)).toBe("AUTH_CURRENT_PASSWORD_INVALID");
    const ok = await admin.post("/api/account/totp/disable", {
      password: STRONG_PASSWORD,
      code: generateTotp(enrollment.secret, ctx.clock.now),
    });
    expect(ok.status).toBe(204);
    const login = await json<LoginResponse>(
      await new TestClient(ctx, "192.0.2.91").login("admin", STRONG_PASSWORD),
    );
    expect(login.status).toBe("authenticated");
  });
});

describe("audit trail", () => {
  it("records security events and paginates", async () => {
    const { ctx, admin } = await setupWithAdmin();
    await new TestClient(ctx, "192.0.2.100").login("admin", "wrong-password-1");
    await new TestClient(ctx, "192.0.2.100").login("admin", STRONG_PASSWORD);
    const page = await json<AuditPage>(await admin.get("/api/audit?limit=2"));
    expect(page.events).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const all = await json<AuditPage>(await admin.get("/api/audit?limit=50"));
    const actions = all.events.map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        "setup.complete:success",
        "auth.login:failure",
        "auth.login:success",
      ]),
    );
    expect(JSON.stringify(all)).not.toContain(STRONG_PASSWORD);
  });
});

describe("HTTP hardening", () => {
  it("sets security headers and disables caching for API responses", async () => {
    const ctx = await createTestContext();
    const response = await new TestClient(ctx).get("/api/bootstrap");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects oversized and malformed bodies", async () => {
    const { admin } = await setupWithAdmin();
    const big = await admin.request("PATCH", "/api/account", {
      rawBody: JSON.stringify({ displayName: "x".repeat(70_000) }),
      headers: { "content-type": "application/json" },
    });
    expect(big.status).toBe(413);
    const malformed = await admin.request("PATCH", "/api/account", {
      rawBody: "{",
      headers: { "content-type": "application/json" },
    });
    expect(await errorCode(malformed)).toBe("BAD_REQUEST");
    const unknownField = await admin.patch("/api/account", { locale: "tr", isAdmin: true });
    expect(await errorCode(unknownField)).toBe("VALIDATION_FAILED");
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const ctx = await createTestContext();
    const response = await new TestClient(ctx).get("/api/does-not-exist");
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("NOT_FOUND");
  });

  it("trusts forwarded headers only from configured proxies", async () => {
    const ctx = await createTestContext({
      configure: (config) => (config.server.trustedProxies = ["10.0.0.1"]),
    });
    const forwarded = {
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "everyos.example",
    };
    const viaProxy = await json<BootstrapResponse>(
      await new TestClient(ctx, "10.0.0.1").get("/api/bootstrap", { headers: forwarded }),
    );
    expect(viaProxy.transport).toEqual({ secure: true, loopback: false });
    const spoofed = await json<BootstrapResponse>(
      await new TestClient(ctx, "127.0.0.1").get("/api/bootstrap", { headers: forwarded }),
    );
    expect(spoofed.transport).toEqual({ secure: false, loopback: true });

    const client = new TestClient(ctx, "10.0.0.1");
    const response = await client.post(
      "/api/setup",
      {
        setupToken: ctx.readSetupToken(),
        username: "admin",
        displayName: "A",
        password: STRONG_PASSWORD,
        locale: "tr",
      },
      { headers: { ...forwarded, origin: "https://everyos.example" } },
    );
    expect(response.status).toBe(201);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-everyos_session=/);
    expect(cookie).toMatch(/Secure/);
    const audit = ctx.db.get<{ ip: string }>(
      "SELECT ip FROM audit_events WHERE action = 'setup.complete'",
    );
    expect(audit?.ip).toBe("203.0.113.9");
  });
});

describe("web client serving", () => {
  function webFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "everyos-web-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>EveryOS</title>");
    writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log('everyos')");
    writeFileSync(join(dir, "assets", "app-abc123.js.br"), "BROTLI");
    return dir;
  }

  it("serves the SPA shell, hashed assets and pre-compressed files", async () => {
    const ctx = await createTestContext({ webDir: webFixture() });
    const client = new TestClient(ctx);
    const root = await client.get("/");
    expect(root.status).toBe(200);
    expect(root.headers.get("cache-control")).toBe("no-cache");
    expect(await root.text()).toContain("<title>EveryOS</title>");
    expect(await (await client.get("/settings/appearance")).text()).toContain(
      "<title>EveryOS</title>",
    );

    const asset = await client.get("/assets/app-abc123.js");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toBe("console.log('everyos')");
    const brotli = await client.get("/assets/app-abc123.js", {
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(brotli.headers.get("content-encoding")).toBe("br");
    expect((await client.get("/assets/missing.js")).status).toBe(404);
  });

  it("never serves files outside the web root", async () => {
    const ctx = await createTestContext({ webDir: webFixture() });
    writeFileSync(join(ctx.dir, "secret.txt"), "top secret");
    const client = new TestClient(ctx);
    for (const path of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/%252e%252e/secret.txt",
      "/..%5csecret.txt",
      "/%00",
    ]) {
      const response = await client.get(path);
      expect(await response.text()).not.toContain("top secret");
    }
  });

  it("sends Origin-less API requests from non-browser clients through validation", async () => {
    const ctx = await createTestContext();
    const response = await new TestClient(ctx).post(
      "/api/auth/login",
      { username: "x", password: "y" },
      { noOrigin: true },
    );
    expect(response.status).toBe(401);
    expect(TEST_ORIGIN).toBe("http://localhost:7470");
  });
});
