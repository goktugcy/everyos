import { describe, expect, it } from "vitest";
import { AgentClientError } from "@everyos/agent-protocol";
import { emptyRemoteNode } from "@everyos/system";
import type { RemoteAccessOverview } from "@everyos/shared";
import { json, withRoles, type TestContext } from "./test-support.ts";
import { remoteAccessProviders } from "./modules/remote-access/providers.ts";

function fixture(ctx: TestContext) {
  ctx.agent.handlers.set("remoteAccess.snapshot", () => ({
    providers: ["tailscale", "netbird"].map((provider) => ({
      ...emptyRemoteNode(provider as "tailscale" | "netbird"),
      installed: true,
      available: true,
      state: "connected",
      dnsEnabled: true,
      routeVisibility: true,
      defaultRoute: true,
      routes: ["10.0.0.0/8"],
    })),
    installations: [],
  }));
  ctx.agent.handlers.set("remoteAccess.peers", () => ({ peers: [] }));
  ctx.agent.handlers.set("remoteAccess.connect", () => emptyRemoteNode("netbird"));
  ctx.agent.handlers.set("remoteAccess.disconnect", () => emptyRemoteNode("netbird"));
  ctx.agent.handlers.set("remoteAccess.install", () => ({
    provider: "netbird",
    status: "running",
    stage: "preparing",
    error: null,
    startedAt: 1,
    finishedAt: null,
  }));
}
const config = {
  managementUrl: "https://vpn.example.test:8443",
  acceptDNS: false,
  acceptRoutes: true,
  confirm: true,
};
describe("remote access HTTP API", () => {
  it("provides public node telemetry and conflicts but protects peers, configuration and host operations", async () => {
    const { ctx, admin, viewer, operator } = await withRoles();
    fixture(ctx);
    const overview = await json<RemoteAccessOverview>(await viewer.get("/api/remote-access"));
    expect(overview.canManage).toBe(false);
    expect(overview.conflicts.map((v) => v.kind)).toEqual([
      "multiple-active",
      "dns",
      "exit-node",
      "subnet",
    ]);
    for (const user of [viewer, operator]) {
      expect((await user.get("/api/remote-access/netbird/peers")).status).toBe(403);
      expect(
        (await user.request("PUT", "/api/remote-access/netbird/settings", { body: config })).status,
      ).toBe(403);
      for (const action of ["connect", "disconnect", "install"])
        expect(
          (
            await user.post(`/api/remote-access/netbird/${action}`, {
              confirm: true,
              acknowledgeConflicts: true,
              configureRepository: true,
            })
          ).status,
        ).toBe(403);
    }
    expect((await admin.get("/api/remote-access/netbird/peers")).status).toBe(200);
    expect(ctx.agent.calls.filter((v) => v.op === "remoteAccess.peers")).toHaveLength(1);
  });
  it("persists only public desired configuration, and forwards a transient credential to the typed agent command", async () => {
    const { ctx, admin } = await withRoles();
    fixture(ctx);
    expect(
      (await admin.request("PUT", "/api/remote-access/netbird/settings", { body: config })).status,
    ).toBe(200);
    expect(ctx.agent.calls.some((v) => v.op === "remoteAccess.connect")).toBe(false);
    const actor = {
      kind: "user" as const,
      userId: "owner",
      username: "owner",
      role: "admin" as const,
    };
    const reloaded = await remoteAccessProviders(ctx.services).overview(actor, true);
    expect(reloaded.providers.find((v) => v.node.provider === "netbird")?.settings).toEqual({
      managementUrl: config.managementUrl,
      acceptDNS: false,
      acceptRoutes: true,
    });
    expect(
      (
        await admin.post("/api/remote-access/netbird/connect", {
          confirm: true,
          credential: "transient-test-key",
          acknowledgeConflicts: true,
        })
      ).status,
    ).toBe(200);
    expect(ctx.agent.calls.find((v) => v.op === "remoteAccess.connect")?.params).toEqual({
      provider: "netbird",
      settings: { managementUrl: config.managementUrl, acceptDNS: false, acceptRoutes: true },
      credential: "transient-test-key",
      acknowledgeConflicts: true,
    });
    const stored = JSON.stringify(ctx.db.all("SELECT value FROM instance_settings"));
    expect(stored).not.toContain("transient-test-key");
    expect(JSON.stringify(ctx.db.all("SELECT * FROM audit_events"))).not.toContain(
      "transient-test-key",
    );
    expect(
      (
        await admin.post("/api/remote-access/netbird/install", {
          confirm: true,
          configureRepository: true,
        })
      ).status,
    ).toBe(202);
    expect(
      (await admin.post("/api/remote-access/netbird/disconnect", { confirm: true })).status,
    ).toBe(200);
    expect(
      ctx.agent.calls
        .filter((v) => /remoteAccess\.(connect|install|disconnect)/.test(v.op))
        .every((v) => (v.params as { provider: string }).provider === "netbird"),
    ).toBe(true);
  });
  it("rejects unconfirmed requests, unknown fields and unsafe server addresses, and preserves safe agent errors", async () => {
    const { ctx, admin } = await withRoles();
    fixture(ctx);
    for (const address of [
      "http://server.test",
      "https://user:secret@server.test",
      "https://server.test/path",
      "https://server.test?secret=x",
    ])
      expect(
        (
          await admin.request("PUT", "/api/remote-access/netbird/settings", {
            body: { ...config, managementUrl: address },
          })
        ).status,
      ).toBe(400);
    expect(
      (await admin.request("PUT", "/api/remote-access/tailscale/settings", { body: config }))
        .status,
    ).toBe(400);
    expect((await admin.get("/api/remote-access/unknown/peers")).status).toBe(400);
    expect(
      (await admin.post("/api/remote-access/netbird/connect", { acknowledgeConflicts: true }))
        .status,
    ).toBe(400);
    expect(
      (
        await admin.post("/api/remote-access/netbird/disconnect", {
          confirm: true,
          command: "arbitrary",
        })
      ).status,
    ).toBe(400);
    expect((await admin.get("/api/remote-access?extra=1")).status).toBe(400);
    ctx.agent.handlers.set("remoteAccess.connect", () => {
      throw new AgentClientError(
        "AGENT_OPERATION_FAILED",
        "REMOTE_CONFLICT_ACK_REQUIRED",
        "conflict",
      );
    });
    const conflict = await admin.post("/api/remote-access/netbird/connect", {
      confirm: true,
      acknowledgeConflicts: false,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { details: { reason: "REMOTE_CONFLICT_ACK_REQUIRED" } },
    });
  });
});
