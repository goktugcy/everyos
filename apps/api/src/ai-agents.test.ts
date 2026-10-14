import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeAgents } from "../../agent/src/native-agents.ts";
import type { AddressInfo } from "node:net";
import { inspectCompose, parseCompose } from "@everyos/catalogs";
import type { AiAgentKind, AiAgentView, AiConversation, AppJobView } from "@everyos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_IMAGES,
  AGENT_MODELS,
  agentDefaults,
  agentTemplate,
} from "./modules/ai-agents/templates.ts";
import { streamAgentChat } from "./modules/ai-agents/chat-client.ts";
import { json, STRONG_PASSWORD, TestClient, withRoles, type TestContext } from "./test-support.ts";

const contexts: TestContext[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const ctx of contexts.splice(0)) {
    ctx.services.aiAgents.stop();
    ctx.services.apps.stop();
    ctx.services.docker.stop();
    ctx.services.metrics.stop();
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});
function put(
  client: TestClient,
  path: string,
  body: unknown,
  options: { headers?: Record<string, string> } = {},
) {
  return client.request("PUT", path, { ...options, body });
}
async function roles() {
  const result = await withRoles();
  contexts.push(result.ctx);
  return result;
}
async function gateway(
  kind: AiAgentKind,
  options: {
    incomplete?: boolean;
    hold?: boolean;
    error?: boolean;
    echoKey?: boolean;
    agentFailure?: boolean;
  } = {},
) {
  const requests: Array<{ model: string; user: string; messages: unknown[]; stream: boolean }> = [];
  let disconnected = false;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.authorization !== "Bearer fixture-agent-key") {
      response.writeHead(401);
      response.end();
      return;
    }
    if (request.url === "/v1/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: AGENT_MODELS[kind] }] }));
      return;
    }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    const parts: Buffer[] = [];
    for await (const raw of request) parts.push(raw as Buffer);
    requests.push(JSON.parse(Buffer.concat(parts).toString()) as (typeof requests)[number]);
    if (options.error) {
      response.writeHead(500);
      response.end("private-upstream-token-should-never-leak");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (options.agentFailure) {
      // Hermes's failed turn: fallback text, then finish_reason "error" with its own reason.
      const frames = [
        { choices: [{ delta: { content: "Fallback notice" }, finish_reason: null }] },
        {
          choices: [{ delta: {}, finish_reason: "error" }],
          error: {
            message:
              "HTTP 400: {'detail': \"The 'fixture-model' model is not supported.\"}\nkey=fixture-agent-key",
            type: "BadRequestError",
          },
        },
      ];
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    if (options.echoKey) {
      for (const text of ["token:fixture-", "agent-key"])
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: "Merhaba 🌍\n<script>literal</script>" } }] })}\r\n\r\n`;
    const bytes = Buffer.from(frame);
    for (let i = 0; i < bytes.length; i += 7) response.write(bytes.subarray(i, i + 7));
    if (options.hold) {
      response.on("close", () => {
        disconnected = true;
      });
      return;
    }
    if (!options.incomplete) response.write("data: [DONE]\r\n\r\n");
    response.end();
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    disconnected: () => disconnected,
  };
}
function external(kind: AiAgentKind, baseUrl: string) {
  return { ...agentDefaults(kind), mode: "external", baseUrl, gatewayKey: "fixture-agent-key" };
}
async function finished(ctx: TestContext, job: AppJobView) {
  await vi.waitFor(() => expect(ctx.services.apps.job(job.id)?.stage).toMatch(/succeeded|failed/));
  return ctx.services.apps.job(job.id)!;
}

describe("AI agent integrations", () => {
  it("releases a cancelled turn even when the upstream DNS lookup never resolves", async () => {
    const controller = new AbortController();
    const result = streamAgentChat({
      url: "http://pending.example/v1/chat/completions",
      key: "fixture-key",
      model: "fixture-model",
      user: "fixture-user",
      messages: [{ role: "user", content: "hello" }],
      signal: controller.signal,
      resolve: () => new Promise(() => undefined),
      onDelta: () => Promise.resolve(),
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ kind: "offline" });
  });
  it("scrubs a known credential split across upstream delta frames from both live output and history", async () => {
    const { admin } = await roles();
    const fixture = await gateway("hermes", { echoKey: true });
    await put(admin, "/api/ai-agents/hermes", external("hermes", fixture.baseUrl));
    const thread = await json<AiConversation>(
      await admin.post("/api/ai-agents/hermes/conversations", {}),
    );
    const response = await (
      await admin.post("/api/ai-agents/hermes/chat", {
        conversationId: thread.id,
        content: "test credential masking",
      })
    ).text();
    expect(response).not.toContain("fixture-agent-key");
    expect(response).toContain("[REDACTED]");
    const saved = await json<AiConversation>(
      await admin.get(`/api/ai-agents/hermes/conversations/${thread.id}`),
    );
    expect(saved.messages[1]?.content).toBe("token:[REDACTED]");
  });
  it("discovers and imports readable native data without returning keys, duplicating or overwriting continued chats", async () => {
    const { ctx, admin, operator } = await roles();
    const fixture = await gateway("hermes");
    const nativeHome = join(ctx.dir, "native-account"),
      data = join(nativeHome, ".hermes");
    await mkdir(join(data, "sessions"), { recursive: true });
    await writeFile(join(data, "config.yaml"), "model: {default: original-native-model}\n");
    await writeFile(
      join(data, ".env"),
      `API_SERVER_KEY=fixture-agent-key\nAPI_SERVER_PORT=${new URL(fixture.baseUrl).port}\nOPENAI_API_KEY=private-native-provider-key\n`,
    );
    await writeFile(
      join(data, "sessions", "native-thread.jsonl"),
      '{"role":"user","content":"native question"}\n{"role":"assistant","content":"native answer","timestamp":1791325313.5494144}\n',
    );
    const reader = new NativeAgents(await realpath(nativeHome));
    ctx.agent.handlers.set("ai.discover", async () => ({
      source: "host",
      discoveries: await reader.discover(),
    }));
    ctx.agent.handlers.set("ai.snapshot", async (input) => {
      const params = input as { id: string; fingerprint: string; includeHistory: boolean };
      const snapshot = await reader.snapshot(params.id, params.includeHistory);
      if (snapshot.discovery.fingerprint !== params.fingerprint) throw new Error("changed");
      return snapshot;
    });
    expect((await operator.get("/api/ai-agents/discover")).status).toBe(403);
    const discovery = await admin.get("/api/ai-agents/discover"),
      body = await discovery.text();
    expect(body).not.toContain("fixture-agent-key");
    expect(body).not.toContain("native question");
    const result = JSON.parse(body) as {
      discoveries: Array<{ id: string; fingerprint: string; historyCount: number }>;
    };
    expect(result.discoveries[0]?.historyCount).toBe(1);
    const input = {
      id: result.discoveries[0]!.id,
      fingerprint: result.discoveries[0]!.fingerprint,
      includeSettings: true,
      includeHistory: true,
      confirm: "hermes",
    };
    expect(
      (await admin.post("/api/ai-agents/hermes/import", { ...input, confirm: "openclaw" })).status,
    ).toBe(422);
    const imported = await admin.post("/api/ai-agents/hermes/import", input);
    expect(imported.status).toBe(200);
    expect(await json(imported)).toMatchObject({ imported: 1, skipped: 0 });
    expect(await (await admin.get("/api/ai-agents/hermes")).text()).not.toContain(
      "private-native-provider-key",
    );
    const chats = await json<{ conversations: AiConversation[] }>(
        await admin.get("/api/ai-agents/hermes/conversations"),
      ),
      id = chats.conversations[0]!.id;
    await (
      await admin.post("/api/ai-agents/hermes/chat", {
        conversationId: id,
        content: "continued in EveryOS",
      })
    ).text();
    expect(fixture.requests[0]?.messages).toHaveLength(3);
    expect(await json(await admin.post("/api/ai-agents/hermes/import", input))).toMatchObject({
      imported: 0,
      skipped: 1,
    });
    expect(
      (await json<AiConversation>(await admin.get(`/api/ai-agents/hermes/conversations/${id}`)))
        .messages,
    ).toHaveLength(4);
    expect(JSON.stringify(ctx.db.all("SELECT * FROM ai_agent_configs"))).not.toContain(
      "private-native-provider-key",
    );
    expect(JSON.stringify(ctx.db.all("SELECT * FROM ai_conversations"))).not.toContain(
      "native question",
    );
    expect(JSON.stringify(ctx.db.all("SELECT * FROM audit_events"))).not.toContain(
      "private-native-provider-key",
    );
  });
  it("removes earlier imported background tasks and refreshes imported chats unless they were continued", async () => {
    const { ctx, admin } = await roles();
    const fixture = await gateway("hermes");
    await put(admin, "/api/ai-agents/hermes", external("hermes", fixture.baseUrl));
    const chat = (sourceId: string, user: string, turns = 1) => ({
      sourceId,
      messages: Array.from({ length: turns }, (_, turn) => [
        { role: "user", content: turn ? `${user} ${turn}` : user },
        { role: "assistant", content: "answer" },
      ]).flat(),
      updatedAt: 1_000,
      truncated: false,
    });
    // Earlier agent versions returned Open WebUI tasks as chats and dropped text behind tool calls.
    let conversations = [
      chat("task-1", "### Task: first"),
      chat("task-2", "### Task: second"),
      chat("real", "A real question"),
    ];
    ctx.agent.handlers.set("ai.snapshot", () => ({
      discovery: {
        id: "hermes",
        kind: "hermes",
        source: "native",
        name: "hermes",
        fingerprint: "a".repeat(64),
        baseUrl: fixture.baseUrl,
        apiModel: "hermes-agent",
        canImport: true,
        hasGatewayKey: false,
        hasProviderKey: false,
        historyCount: conversations.length,
        historyWarning: null,
      },
      settings: { ...agentDefaults("hermes"), mode: "external", baseUrl: fixture.baseUrl },
      gatewayKey: null,
      providerKey: null,
      conversations,
    }));
    const input = {
      id: "hermes",
      fingerprint: "a".repeat(64),
      includeSettings: false,
      includeHistory: true,
      confirm: "hermes",
    };
    expect(await json(await admin.post("/api/ai-agents/hermes/import", input))).toMatchObject({
      imported: 3,
      removed: 0,
    });
    const list = async () =>
      (
        await json<{ conversations: AiConversation[] }>(
          await admin.get("/api/ai-agents/hermes/conversations"),
        )
      ).conversations.map((entry) => entry.title);
    const continued = (
      await json<{ conversations: AiConversation[] }>(
        await admin.get("/api/ai-agents/hermes/conversations"),
      )
    ).conversations.find((entry) => entry.title === "### Task: second")!;
    await (
      await admin.post("/api/ai-agents/hermes/chat", {
        conversationId: continued.id,
        content: "continued in EveryOS",
      })
    ).text();
    conversations = [chat("real", "A real question", 2)];
    expect(await json(await admin.post("/api/ai-agents/hermes/import", input))).toMatchObject({
      imported: 0,
      updated: 1,
      skipped: 0,
      removed: 1,
    });
    expect((await list()).sort()).toEqual(["### Task: second", "A real question"]);
    const real = (
      await json<{ conversations: AiConversation[] }>(
        await admin.get("/api/ai-agents/hermes/conversations"),
      )
    ).conversations.find((entry) => entry.title === "A real question")!;
    expect(
      (
        await json<AiConversation>(
          await admin.get(`/api/ai-agents/hermes/conversations/${real.id}`),
        )
      ).messages,
    ).toHaveLength(4);
    expect(await json(await admin.post("/api/ai-agents/hermes/import", input))).toMatchObject({
      imported: 0,
      updated: 0,
      skipped: 1,
      removed: 0,
    });
  });
  it("requires permissions and CSRF, validates settings, seals keys, and isolates each owner's history", async () => {
    const { ctx, admin, operator, viewer } = await roles();
    const fixture = await gateway("hermes");
    const input = external("hermes", fixture.baseUrl);
    expect((await new TestClient(ctx).get("/api/ai-agents")).status).toBe(401);
    expect((await put(operator, "/api/ai-agents/hermes", input)).status).toBe(403);
    expect((await viewer.get("/api/ai-agents")).status).toBe(403);
    expect(
      (
        await put(admin, "/api/ai-agents/hermes", input, {
          headers: { "x-everyos-csrf": "invalid" },
        })
      ).status,
    ).toBe(403);
    expect((await put(admin, "/api/ai-agents/hermes", { ...input, shell: "whoami" })).status).toBe(
      400,
    );
    expect(
      (await put(admin, "/api/ai-agents/hermes", { ...input, gatewayKey: "key\r\nInjected: bad" }))
        .status,
    ).toBe(400);
    expect((await put(admin, "/api/ai-agents/hermes", input)).status).toBe(200);
    expect(await json<AiAgentView>(await admin.get("/api/ai-agents/hermes"))).toMatchObject({
      status: "running",
      hasGatewayKey: true,
    });
    expect(await (await admin.get("/api/ai-agents/hermes")).text()).not.toContain(
      "fixture-agent-key",
    );
    expect(JSON.stringify(ctx.db.all("SELECT * FROM ai_agent_configs"))).not.toContain(
      "fixture-agent-key",
    );
    expect((await put(admin, "/api/ai-agents/hermes", { ...input, gatewayKey: "" })).status).toBe(
      200,
    );
    const thread = await json<AiConversation>(
      await admin.post("/api/ai-agents/hermes/conversations", {}),
    );
    await admin.post("/api/users", {
      username: "second-admin",
      displayName: "Second administrator",
      password: STRONG_PASSWORD,
      role: "admin",
    });
    const second = new TestClient(ctx);
    await second.login("second-admin", STRONG_PASSWORD);
    expect((await second.get(`/api/ai-agents/hermes/conversations/${thread.id}`)).status).toBe(404);
    expect((await second.get("/api/ai-agents/hermes")).status).toBe(200);
    expect(
      (
        await second.delete(`/api/ai-agents/hermes/conversations/${thread.id}`, {
          body: { confirmId: thread.id },
        })
      ).status,
    ).toBe(404);
    expect((await admin.get(`/api/ai-agents/openclaw/conversations/${thread.id}`)).status).toBe(
      404,
    );
    expect(
      (await admin.delete(`/api/ai-agents/hermes/conversations/${thread.id}`, { body: {} })).status,
    ).toBe(400);
    expect(
      (
        await admin.delete(`/api/ai-agents/hermes/conversations/${thread.id}`, {
          body: { confirmId: thread.id },
        })
      ).status,
    ).toBe(204);
  });
  it.each(["hermes", "openclaw"] as const)(
    "streams real HTTP %s chat, preserves context and encrypts transcripts",
    async (kind) => {
      const { ctx, admin } = await roles();
      const fixture = await gateway(kind);
      await put(admin, `/api/ai-agents/${kind}`, external(kind, fixture.baseUrl));
      const thread = await json<AiConversation>(
        await admin.post(`/api/ai-agents/${kind}/conversations`, {}),
      );
      const answer = await admin.post(`/api/ai-agents/${kind}/chat`, {
        conversationId: thread.id,
        content: "first-private-message",
      });
      expect(answer.status).toBe(200);
      const stream = await answer.text();
      expect(stream).toContain("event: delta");
      expect(stream).toContain("event: complete");
      expect(stream).toContain("Merhaba 🌍");
      const saved = await json<AiConversation>(
        await admin.get(`/api/ai-agents/${kind}/conversations/${thread.id}`),
      );
      expect(saved.messages).toEqual([
        { role: "user", content: "first-private-message" },
        { role: "assistant", content: "Merhaba 🌍\n<script>literal</script>" },
      ]);
      expect(JSON.stringify(ctx.db.all("SELECT * FROM ai_conversations"))).not.toContain(
        "first-private-message",
      );
      await (
        await admin.post(`/api/ai-agents/${kind}/chat`, {
          conversationId: thread.id,
          content: "second-message",
        })
      ).text();
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests[1]).toMatchObject({ model: AGENT_MODELS[kind], stream: true });
      expect(fixture.requests[1]!.messages).toHaveLength(3);
      expect(fixture.requests[1]!.user).toContain(thread.id);
      expect(JSON.stringify(ctx.db.all("SELECT * FROM audit_events"))).not.toContain(
        "first-private-message",
      );
    },
  );
  it("cancels an active turn on locking and never commits partial answers or repeats it", async () => {
    const { ctx, admin } = await roles();
    ctx.services.eventStreamHeartbeatMs = 15;
    const fixture = await gateway("hermes", { hold: true });
    await put(admin, "/api/ai-agents/hermes", external("hermes", fixture.baseUrl));
    const thread = await json<AiConversation>(
      await admin.post("/api/ai-agents/hermes/conversations", {}),
    );
    const response = await admin.post("/api/ai-agents/hermes/chat", {
      conversationId: thread.id,
      content: "wait",
    });
    const reading = response.text();
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
    expect(
      (
        await admin.post("/api/ai-agents/hermes/chat", {
          conversationId: thread.id,
          content: "duplicate",
        })
      ).status,
    ).toBe(409);
    expect(
      (await put(admin, "/api/ai-agents/hermes", external("hermes", fixture.baseUrl))).status,
    ).toBe(409);
    await admin.post("/api/auth/lock");
    await reading;
    await vi.waitFor(() => expect(fixture.disconnected()).toBe(true));
    expect(fixture.requests).toHaveLength(1);
    expect(
      ctx.services.aiAgents.conversation(
        ctx.services.users.findByUsername("admin")!.id,
        "hermes",
        thread.id,
      ).messages,
    ).toEqual([]);
  });
  it.each([{ incomplete: true }, { error: true }])(
    "rejects incomplete or failed upstream runs without leaking their errors",
    async (options) => {
      const { admin } = await roles();
      const fixture = await gateway("hermes", options);
      await put(admin, "/api/ai-agents/hermes", external("hermes", fixture.baseUrl));
      const thread = await json<AiConversation>(
        await admin.post("/api/ai-agents/hermes/conversations", {}),
      );
      const stream = await (
        await admin.post("/api/ai-agents/hermes/chat", {
          conversationId: thread.id,
          content: "hello",
        })
      ).text();
      expect(stream).toContain("event: error");
      expect(stream).not.toContain("event: complete");
      expect(stream).not.toContain("private-upstream-token");
      expect(
        (
          await json<AiConversation>(
            await admin.get(`/api/ai-agents/hermes/conversations/${thread.id}`),
          )
        ).messages,
      ).toEqual([]);
    },
  );
  it("reports the agent's own redacted failure reason and keeps no partial turn", async () => {
    const { admin } = await roles();
    const fixture = await gateway("hermes", { agentFailure: true });
    await put(admin, "/api/ai-agents/hermes", external("hermes", fixture.baseUrl));
    const thread = await json<AiConversation>(
      await admin.post("/api/ai-agents/hermes/conversations", {}),
    );
    const stream = await (
      await admin.post("/api/ai-agents/hermes/chat", { conversationId: thread.id, content: "hi" })
    ).text();
    expect(stream).not.toContain("event: complete");
    const error = /event: error\ndata: (.+)\n/.exec(stream)?.[1];
    expect(JSON.parse(error ?? "null")).toEqual({
      code: "agent-error",
      message:
        "HTTP 400: {'detail': \"The 'fixture-model' model is not supported.\"} key=[REDACTED]",
    });
    expect(
      (
        await json<AiConversation>(
          await admin.get(`/api/ai-agents/hermes/conversations/${thread.id}`),
        )
      ).messages,
    ).toEqual([]);
  });
  it.each(["hermes", "openclaw"] as const)(
    "installs only the pinned owned %s template through existing agent policy",
    async (kind) => {
      const { ctx, admin } = await roles();
      ctx.agent.handlers.set("apps.run", () => ({
        source: "simulated",
        ok: true,
        rollback: "not-needed",
      }));
      const settings = {
        ...agentDefaults(kind),
        model: "fixture-model",
        provider: "custom" as const,
        providerUrl: "http://192.0.2.1:8000/v1",
        tools: true,
        providerKey: "private$provider$key",
      };
      const template = agentTemplate(
        kind,
        settings,
        "random-generated-api-token",
        "private$provider$key",
      );
      expect(inspectCompose(template.compose).blockers).toEqual([]);
      expect(
        inspectCompose(template.compose).risks.filter((risk) => risk !== "default-secret"),
      ).toEqual([]);
      expect((await put(admin, `/api/ai-agents/${kind}`, settings)).status).toBe(200);
      expect(
        (await admin.post(`/api/ai-agents/${kind}/actions`, { action: "install", confirm: kind }))
          .status,
      ).toBe(202);
      const config = ctx.db.get<{ app_id: string }>(
        "SELECT app_id FROM ai_agent_configs WHERE kind = ?",
        kind,
      )!;
      const view = await json<AiAgentView>(await admin.get(`/api/ai-agents/${kind}`));
      await finished(ctx, view.job!);
      const run = ctx.agent.calls.find((call) => call.op === "apps.run")!;
      const params = run.params as { id: string; compose: string; riskOverride: boolean };
      expect(params.id).toBe(config.app_id);
      expect(params.riskOverride).toBe(false);
      expect(run.actor).toMatchObject({ kind: "user", username: "admin" });
      const doc = parseCompose(params.compose),
        service = (doc.services as Record<string, Record<string, unknown>>)[kind]!;
      expect(service.image).toBe(AGENT_IMAGES[kind]);
      expect(service.ports).toEqual([
        { target: kind === "hermes" ? 8642 : 18789, host_ip: "127.0.0.1", protocol: "tcp" },
      ]);
      expect(JSON.stringify(service)).not.toContain("docker.sock");
      expect(JSON.stringify(service)).not.toContain("privileged");
      expect(params.compose).toContain("private$$provider$$key");
      expect(
        (await admin.post(`/api/ai-agents/${kind}/actions`, { action: "install", confirm: kind }))
          .status,
      ).toBe(409);
      expect(
        (
          await admin.post(`/api/ai-agents/${kind}/actions`, {
            action: "restart",
            confirm: kind === "hermes" ? "openclaw" : "hermes",
          })
        ).status,
      ).toBe(422);
      expect((await admin.get(`/api/ai-agents/${kind}`)).status).toBe(200);
      expect(await (await admin.get(`/api/ai-agents/${kind}`)).text()).not.toContain(
        "private$provider$key",
      );
    },
  );
});
