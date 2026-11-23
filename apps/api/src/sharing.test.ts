import { AgentClientError } from "@everyos/agent-protocol";
import { describe, expect, it, afterEach } from "vitest";
import type { QuickShareView, SessionInfo } from "@everyos/shared";
import {
  createTestContext,
  completeSetup,
  TestClient,
  json,
  withRoles,
  type TestContext,
} from "./test-support.ts";

const contexts: TestContext[] = [];
afterEach(() => {
  for (const c of contexts.splice(0)) {
    c.services.transfers.stop();
    c.services.sharing.close();
  }
});
async function setup() {
  const ctx = await createTestContext();
  contexts.push(ctx);
  const admin = new TestClient(ctx);
  await completeSetup(ctx, admin);
  return { ctx, admin, guest: new TestClient(ctx) };
}
const input = {
  name: "Share fixture",
  direction: "send",
  root: "home",
  path: "",
  paths: ["fixture.txt"],
  lifetimeMinutes: 15,
  oneTime: false,
  maxDownloads: 10,
  maxBytes: 4096,
};
async function share(admin: TestClient, options: Record<string, unknown> = {}) {
  expect(
    (
      await admin.request("PUT", "/api/files/text", {
        body: {
          root: "home",
          path: "fixture.txt",
          content: "Real offline fixture bytes",
          etag: null,
        },
      })
    ).status,
  ).toBe(200);
  const result = await admin.post("/api/sharing/quick", { ...input, ...options });
  expect(result.status).toBe(201);
  return json<{ share: QuickShareView; token: string; url: string }>(result);
}
async function access(guest: TestClient, token: string, password?: string) {
  return guest.post("/api/quick-share/access", password ? { password } : {}, {
    headers: { Authorization: "Bearer " + token },
  });
}
describe("built-in network sharing and capability-scoped Quick Share", () => {
  it("streams a real selected file to a guest, without creating an EveryOS account", async () => {
    const { ctx, admin, guest } = await setup();
    const created = await share(admin);
    expect(created.url).toMatch(/\/share#[A-Za-z0-9_-]{43}$/);
    const row = ctx.db.get<{ token_hash: string; sealed_token: string; config: string }>(
      "SELECT * FROM quick_shares WHERE id=?",
      created.share.id,
    )!;
    expect(row.token_hash).not.toContain(created.token);
    expect(row.sealed_token).not.toContain(created.token);
    const opened = await access(guest, created.token);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("set-cookie")).toContain("HttpOnly");
    expect(opened.headers.get("set-cookie")).toContain("SameSite=Strict");
    const metadata = await guest.get("/api/quick-share/" + created.share.id);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      entries: [{ index: 0, name: "fixture.txt", size: 26 }],
    });
    const download = await guest.get("/api/quick-share/" + created.share.id + "/download/0");
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(await download.text()).toBe("Real offline fixture bytes");
    await new Promise((r) => setTimeout(r, 20));
    const me = await json<SessionInfo>(await admin.get("/api/auth/session"));
    expect(ctx.services.transfers.list(me.user.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "fixture.txt", state: "done", bytesDone: 26 }),
      ]),
    );
    expect((await guest.get("/api/files/roots")).status).toBe(401);
  });
  it("checks passwords, consumes one-time claims atomically, and exposes no source path to guests", async () => {
    const { ctx, admin, guest } = await setup();
    const password = "guest-password-fixture-only";
    const created = await share(admin, { oneTime: true, password });
    expect((await access(guest, created.token)).status).toBe(403);
    expect((await access(guest, created.token, "wrong-password")).status).toBe(403);
    const results = await Promise.all([
      access(guest, created.token, password),
      access(new TestClient(ctx), created.token, password),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    const stored = ctx.db.get<{ config: string; password_hash: string }>(
      "SELECT * FROM quick_shares WHERE id=?",
      created.share.id,
    )!;
    expect(stored.config).not.toContain(password);
    expect(stored.password_hash).not.toContain(password);
    const success = results.find((r) => r.status === 200)!;
    const grant = await json<{ grant: string }>(success);
    const request = await guest.get("/api/quick-share/" + created.share.id, {
      headers: { Authorization: "Bearer " + grant.grant },
    });
    const response = JSON.stringify(await request.json());
    expect(response).not.toMatch(/token_hash|sealed_|root|paths|password_hash/);
  });
  it("rejects expired, revoked, forged and exhausted capabilities", async () => {
    const { ctx, admin, guest } = await setup();
    const created = await share(admin, { maxDownloads: 1, lifetimeMinutes: 1 });
    expect((await access(guest, created.token)).status).toBe(200);
    const path = "/api/quick-share/" + created.share.id + "/download/0";
    expect(await (await guest.get(path)).text()).toBe("Real offline fixture bytes");
    expect((await guest.get(path)).status).toBe(409);
    expect((await guest.get("/api/quick-share/" + created.share.id + "/download/1")).status).toBe(
      404,
    );
    ctx.clock.now += 60001;
    expect((await guest.get("/api/quick-share/" + created.share.id)).status).toBe(410);
    expect((await access(guest, "x".repeat(43))).status).toBe(410);
    const fresh = await admin.post("/api/sharing/quick", input);
    const second = await json<{ share: QuickShareView; token: string }>(fresh);
    expect((await access(guest, second.token)).status).toBe(200);
    expect(
      (await admin.delete("/api/sharing/quick/" + second.share.id, { body: { confirm: true } }))
        .status,
    ).toBe(204);
    expect((await guest.get("/api/quick-share/" + second.share.id)).status).toBe(410);
  });
  it("receives streamed files into only the selected folder with collision and quota protection", async () => {
    const { admin, guest } = await setup();
    expect(
      (await admin.post("/api/files/mkdir", { root: "home", path: "", name: "Receive" })).status,
    ).toBe(201);
    const response = await admin.post("/api/sharing/quick", {
      ...input,
      direction: "receive",
      paths: [],
      path: "Receive",
      maxBytes: 6,
    });
    expect(response.status).toBe(201);
    const created = await json<{ share: QuickShareView; token: string }>(response);
    const opened = await json<{ grant: string }>(await access(guest, created.token));
    const target = "/api/quick-share/" + created.share.id + "/upload?name=video.txt";
    expect(
      (await guest.request("POST", target, { rawBody: "abc", headers: { "content-length": "3" } }))
        .status,
    ).toBe(403);
    const headers = { "content-length": "3", "x-everyos-quick-grant": opened.grant };
    expect((await guest.request("POST", target, { rawBody: "abc", headers })).status).toBe(201);
    expect((await guest.request("POST", target, { rawBody: "def", headers })).status).toBe(201);
    const listing = await json<{ entries: Array<{ name: string }> }>(
      await admin.get("/api/files/list?root=home&path=Receive"),
    );
    expect(listing.entries.map((e) => e.name).sort()).toEqual(["video (2).txt", "video.txt"]);
    expect((await guest.request("POST", target, { rawBody: "ghi", headers })).status).toBe(409);
    expect(
      (
        await guest.request("POST", target.replace("video.txt", "..%2Fescape.txt"), {
          rawBody: "ghi",
          headers,
        })
      ).status,
    ).toBe(400);
    expect((await admin.get("/api/files/text?root=home&path=Receive%2Fvideo.txt")).status).toBe(
      200,
    );
  });
  it("keeps private-network and HTTPS boundaries independent of forwarded headers", async () => {
    const { ctx, admin, guest } = await setup();
    const created = await share(admin);
    expect((await access(guest, created.token)).status).toBe(200);
    const path = "/api/quick-share/" + created.share.id;
    expect(
      (
        await guest.get(path, {
          ip: "8.8.8.8",
          headers: { "x-forwarded-for": "192.168.1.5", "x-forwarded-proto": "https" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await guest.get(path, { ip: "192.168.1.5", headers: { "x-forwarded-proto": "https" } }))
        .status,
    ).toBe(400);
    expect((await guest.get(path, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(
      403,
    );
    const users = ctx.db.get<{ n: number }>("SELECT count(*) n FROM users");
    expect(users?.n).toBe(1);
  });
  it("enforces owner, role, strict schema and confirmation checks before native dispatch", async () => {
    const { ctx, admin, operator, viewer } = await withRoles();
    contexts.push(ctx);
    const target = {
      name: "Native fixture",
      protocol: "nfs",
      host: "192.168.20.2",
      port: 2049,
      remotePath: "/exports/files",
      username: "",
      version: "4.2",
      readOnly: true,
      enabled: true,
      persistent: false,
      automount: true,
      fingerprint: null,
      confirm: true,
    };
    expect((await viewer.post("/api/sharing/connections", target)).status).toBe(403);
    expect((await operator.post("/api/sharing/connections", target)).status).toBe(403);
    expect(
      (await admin.post("/api/sharing/connections", { ...target, mountPoint: "/etc" })).status,
    ).toBe(400);
    expect(
      (
        await admin.post("/api/sharing/folders", {
          name: "Forbidden",
          protocol: "nfs",
          root: "home",
          path: "",
          clients: ["0.0.0.0/0"],
          users: [],
          readOnly: true,
          enabled: true,
          confirm: true,
        })
      ).status,
    ).toBe(400);
    ctx.agent.handlers.set("sharing.mount.apply", () => ({
      target: "/mnt/everyos-network/fixture",
    }));
    const saved = await json<{ id: string }>(await admin.post("/api/sharing/connections", target));
    expect(saved.id).toBeTypeOf("string");
    expect(
      (await operator.delete("/api/sharing/connections/" + saved.id, { body: { confirm: true } }))
        .status,
    ).toBe(404);
    expect(ctx.agent.calls.filter((c) => c.op === "sharing.mount.apply")).toHaveLength(1);
  });
  it("ends queued downloads on cancellation and keeps capability values out of audit records", async () => {
    const { ctx, admin, guest } = await setup();
    const created = await share(admin);
    const opened = await json<{ grant: string }>(await access(guest, created.token));
    const owner = ctx.services.users.findByUsername("admin")!.id;
    for (let i = 0; i < 2; i++)
      ctx.services.transfers.start(owner, {
        direction: "download",
        name: "queue fixture",
        from: "fixture",
        to: "fixture",
        run: (_progress, signal) =>
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
      });
    const response = await guest.get("/api/quick-share/" + created.share.id + "/download/0");
    const queued = ctx.services.transfers.list(owner).find((j) => j.state === "queued")!;
    expect(queued).toBeDefined();
    ctx.services.transfers.cancel(owner, queued.id);
    await expect(response.text()).rejects.toThrow();
    const audit = JSON.stringify(
      ctx.db.all("SELECT * FROM audit_events WHERE action LIKE 'sharing.%'"),
    );
    expect(audit).toContain("sharing.quick.access");
    expect(audit).not.toContain(created.token);
    expect(audit).not.toContain(opened.grant);
  });
  it("enforces item quotas even for empty uploads and clears restart-only reservations", async () => {
    const { ctx, admin, guest } = await setup();
    const created = await share(admin, { direction: "receive", paths: [], path: "" });
    const opened = await json<{ grant: string }>(await access(guest, created.token));
    ctx.db.run("UPDATE quick_shares SET uploads=100 WHERE id=?", created.share.id);
    const response = await guest.request(
      "POST",
      "/api/quick-share/" + created.share.id + "/upload?name=empty.txt",
      { rawBody: "", headers: { "content-length": "0", "x-everyos-quick-grant": opened.grant } },
    );
    expect(response.status).toBe(409);
    ctx.db.run(
      "UPDATE quick_shares SET reserved_bytes=400,reserved_uploads=2 WHERE id=?",
      created.share.id,
    );
    ctx.services.quickShares.initialize();
    expect(
      ctx.db.get(
        "SELECT reserved_bytes,reserved_uploads,uploads FROM quick_shares WHERE id=?",
        created.share.id,
      ),
    ).toEqual({ reserved_bytes: 0, reserved_uploads: 0, uploads: 100 });
  });
  it("disables native metadata after a Linux binding changes and permits removal of stale host records", async () => {
    const { ctx, admin } = await setup();
    ctx.agent.handlers.set("sharing.mount.apply", () => ({
      target: "/mnt/everyos-network/fixture",
    }));
    ctx.agent.handlers.set("identity.unbind", () => null);
    const saved = await json<{ id: string }>(
      await admin.post("/api/sharing/connections", {
        name: "Binding fixture",
        protocol: "nfs",
        host: "192.168.20.2",
        port: 2049,
        remotePath: "/data",
        username: "",
        version: "4.2",
        confirm: true,
      }),
    );
    const user = ctx.services.users.findByUsername("admin")!;
    const response = await admin.delete("/api/users/" + user.id + "/linux-account", {
      body: { password: "mavi-gokyuzu-ve-daglar-42" },
    });
    expect(response.status).toBe(204);
    const config = JSON.parse(
      ctx.db.get<{ config: string }>("SELECT config FROM network_connections WHERE id=?", saved.id)!
        .config,
    ) as { enabled: boolean };
    expect(config.enabled).toBe(false);
    ctx.agent.handlers.set("sharing.mount.remove", () => {
      throw new AgentClientError("AGENT_OPERATION_FAILED", "Not found", "not_found");
    });
    expect(
      (await admin.delete("/api/sharing/connections/" + saved.id, { body: { confirm: true } }))
        .status,
    ).toBe(204);
    expect(ctx.db.get("SELECT id FROM network_connections WHERE id=?", saved.id)).toBeUndefined();
  });
  it("revokes a large active stream and retains HTTP Range support within the download quota", async () => {
    const { ctx, admin, guest } = await setup();
    const bytes = Buffer.alloc(8 * 1024 ** 2, 0x67);
    expect(
      (
        await admin.request("POST", "/api/files/upload?root=home&path=&name=large.bin", {
          rawBody: bytes,
          headers: { "content-length": String(bytes.length) },
        })
      ).status,
    ).toBe(201);
    const created = await json<{ share: QuickShareView; token: string }>(
      await admin.post("/api/sharing/quick", { ...input, paths: ["large.bin"] }),
    );
    await access(guest, created.token);
    const range = await guest.get("/api/quick-share/" + created.share.id + "/download/0", {
      headers: { range: "bytes=4-103" },
    });
    expect(range.status).toBe(206);
    expect((await range.arrayBuffer()).byteLength).toBe(100);
    const response = await guest.get("/api/quick-share/" + created.share.id + "/download/0");
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(
      (await admin.delete("/api/sharing/quick/" + created.share.id, { body: { confirm: true } }))
        .status,
    ).toBe(204);
    await expect(
      (async () => {
        while (!(await reader.read()).done) {
          /* Drain buffered bytes until revocation is observed. */
        }
      })(),
    ).rejects.toThrow();
    expect((await guest.get("/api/quick-share/" + created.share.id)).status).toBe(410);
    expect(
      ctx.services.transfers
        .list(ctx.services.users.findByUsername("admin")!.id)
        .some((j) => j.name === "large.bin"),
    ).toBe(true);
  });
});
