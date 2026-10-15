import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { parseCompose } from "@everyos/catalogs";
import {
  DEFAULT_LOCAL_BEHAVIOR,
  type AiAgentView,
  type AiConversation,
  type AppJobView,
  type LocalModelPull,
  type LocalModelsView,
} from "@everyos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INSTRUCTIONS } from "./modules/ai-agents/behavior.ts";
import { agentDefaults, agentTemplate, ollamaTemplate } from "./modules/ai-agents/templates.ts";
import { json, withRoles, type TestContext } from "./test-support.ts";

const contexts: TestContext[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const ctx of contexts.splice(0)) {
    ctx.services.aiAgents.stop();
    ctx.services.localModels.stop();
    ctx.services.apps.stop();
    ctx.services.docker.stop();
    ctx.services.metrics.stop();
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});
async function roles() {
  const result = await withRoles();
  contexts.push(result.ctx);
  return result;
}

/** A real HTTP Ollama look-alike: versions, models, streamed pulls, deletion and chat. */
async function ollama(options: { key?: string; openAiOnly?: boolean } = {}) {
  const models = new Set(["qwen3:0.6b"]);
  const requests: Array<{ path: string; auth: string | undefined; body: unknown }> = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part as Buffer);
    const body = parts.length ? (JSON.parse(Buffer.concat(parts).toString()) as unknown) : null;
    requests.push({ path: request.url ?? "", auth: request.headers.authorization, body });
    if (options.key && request.headers.authorization !== `Bearer ${options.key}`) {
      response.writeHead(401);
      response.end();
      return;
    }
    const send = (value: unknown) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(value));
    };
    // LM Studio, llama.cpp and vLLM only speak the OpenAI API.
    if (options.openAiOnly && request.url?.startsWith("/api/")) {
      response.writeHead(404);
      response.end();
      return;
    }
    switch (`${request.method} ${request.url}`) {
      case "GET /api/version":
        return send({ version: "0.40.4" });
      case "GET /api/tags":
        return send({
          models: [...models].map((name) => ({
            name,
            size: 523_000_000,
            details: { family: "qwen3", parameter_size: "751.63M", quantization_level: "Q4_K_M" },
          })),
        });
      case "GET /v1/models":
        return send({ data: [...models].map((id) => ({ id, owned_by: "library" })) });
      case "POST /api/pull": {
        const { model } = body as { model: string };
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (model === "missing:latest") {
          response.end(
            `${JSON.stringify({ error: "pull model manifest: file does not exist" })}\n`,
          );
          return;
        }
        for (const line of [
          { status: "pulling manifest" },
          { status: "pulling abc", total: 100, completed: 40 },
          { status: "pulling abc", total: 100, completed: 100 },
          { status: "success" },
        ])
          response.write(`${JSON.stringify(line)}\n`);
        models.add(model);
        response.end();
        return;
      }
      case "DELETE /api/delete":
        models.delete((body as { model: string }).model);
        return send({});
      case "POST /api/chat": {
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        for (const line of [
          { message: { role: "assistant", content: "Yerel " }, done: false },
          { message: { role: "assistant", content: "yanıt" }, done: false },
          { message: { role: "assistant", content: "" }, done: true, done_reason: "stop" },
        ])
          response.write(`${JSON.stringify(line)}\n`);
        response.end();
        return;
      }
      case "POST /v1/chat/completions": {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Yerel yanıt" } }] })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
        return;
      }
    }
    response.writeHead(404);
    response.end();
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, models, requests };
}
/** Drops an installed EveryOS Ollama record, as a removal from Applications would. */
async function removeOllama(ctx: TestContext) {
  ctx.db.run('UPDATE installed_apps SET removed = 1 WHERE provenance LIKE \'%"path":"ollama"%\'');
  return Promise.resolve();
}
/** Announces fixture servers the way the agent reports listening sockets. */
function sockets(
  ctx: TestContext,
  entries: Array<{ port: number; address: string; process: string }>,
) {
  ctx.agent.handlers.set("network.sockets", () => ({
    source: "host",
    listening: entries.map((entry) => ({ protocol: "tcp", ...entry })),
    connections: { established: 0, timeWait: 0, other: 0 },
  }));
}
async function view(client: Awaited<ReturnType<typeof roles>>["admin"]) {
  return json<LocalModelsView>(await client.get("/api/ai-agents/local-models"));
}

describe("local model servers", () => {
  it("finds native and container servers, their models and whether agent containers can reach them", async () => {
    const { ctx, admin, viewer } = await roles();
    const native = await ollama(),
      guarded = await ollama({ key: "server-key" });
    sockets(ctx, [
      { port: native.port, address: "0.0.0.0", process: "ollama" },
      { port: guarded.port, address: "127.0.0.1", process: "ollama" },
    ]);
    const llama = await ollama();
    ctx.agent.handlers.set("docker.containers.list", () => ({
      source: "host",
      containers: [
        {
          id: "c0ffee000000aaaa",
          name: "big-bear-ollama-cpu",
          image: "ollama/ollama:0.34.2",
          state: "running",
          health: null,
          ports: [{ privatePort: 11434, publicPort: llama.port, type: "tcp", ip: "0.0.0.0" }],
          project: "big-bear-ollama",
          service: "ollama",
          networks: [],
          managerHint: null,
          protected: false,
        },
      ],
    }));
    expect((await viewer.get("/api/ai-agents/local-models")).status).toBe(403);
    const result = await view(admin);
    const byId = Object.fromEntries(result.servers.map((server) => [server.id, server]));
    expect(byId[`port:${native.port}`]).toMatchObject({
      kind: "ollama",
      source: "native",
      version: "0.40.4",
      online: true,
      manageable: true,
      containerAccess: "host-gateway",
      containerUrl: `http://host.docker.internal:${native.port}`,
      models: [{ id: "qwen3:0.6b", parameters: "751.63M", quantization: "Q4_K_M" }],
    });
    // Only the OpenAI listing is guarded; a 401 marks the key requirement.
    expect(byId[`port:${guarded.port}`]).toMatchObject({
      online: true,
      needsKey: true,
      containerAccess: "loopback-only",
      containerUrl: null,
    });
    expect(byId["container:c0ffee000000"]).toMatchObject({
      source: "container",
      name: "big-bear-ollama-cpu",
      baseUrl: `http://127.0.0.1:${llama.port}`,
      containerAccess: "host-gateway",
    });
    expect(result.ollama).toMatchObject({ app: null, acceleration: "cpu", unavailable: null });
  });

  it("chats directly with a local model without a key and keeps the history per account", async () => {
    const { ctx, admin } = await roles();
    const server = await ollama();
    sockets(ctx, [{ port: server.port, address: "127.0.0.1", process: "ollama" }]);
    const settings = {
      ...agentDefaults("local"),
      mode: "external",
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiModel: "qwen3:0.6b",
    };
    expect((await admin.request("PUT", "/api/ai-agents/local", { body: settings })).status).toBe(
      200,
    );
    const agent = await json<AiAgentView>(await admin.get("/api/ai-agents/local"));
    expect(agent).toMatchObject({ kind: "local", status: "running", hasGatewayKey: false });
    expect(agent.settings).toMatchObject({ model: "qwen3:0.6b", tools: false });
    // A model the server does not have is reported, not hidden.
    await admin.request("PUT", "/api/ai-agents/local", {
      body: { ...settings, apiModel: "absent:1b" },
    });
    expect((await json<AiAgentView>(await admin.get("/api/ai-agents/local"))).status).toBe("error");
    await admin.request("PUT", "/api/ai-agents/local", { body: settings });
    const thread = await json<AiConversation>(
      await admin.post("/api/ai-agents/local/conversations", {}),
    );
    const stream = await (
      await admin.post("/api/ai-agents/local/chat", {
        conversationId: thread.id,
        content: "Merhaba",
      })
    ).text();
    expect(stream).toContain("event: complete");
    // Ollama's own API, with EveryOS's default instructions and parameters.
    const chat = server.requests.find((entry) => entry.path === "/api/chat")!;
    expect(chat.auth).toBeUndefined();
    expect(chat.body).toEqual({
      model: "qwen3:0.6b",
      stream: true,
      messages: [
        {
          role: "system",
          content: `${DEFAULT_INSTRUCTIONS}\n\nReply in the same language as the user's latest message.`,
        },
        { role: "user", content: "Merhaba" },
      ],
      options: { temperature: 0.43, num_predict: 1200, repeat_penalty: 1.09 },
    });
    expect(
      (
        await json<AiConversation>(
          await admin.get(`/api/ai-agents/local/conversations/${thread.id}`),
        )
      ).messages,
    ).toEqual([
      { role: "user", content: "Merhaba" },
      { role: "assistant", content: "Yerel yanıt" },
    ]);
    expect(
      (
        await json<{ conversations: AiConversation[] }>(
          await admin.get("/api/ai-agents/hermes/conversations"),
        )
      ).conversations,
    ).toEqual([]);
  });

  it("applies the behavior settings through Ollama's API and OpenAI parameters elsewhere", async () => {
    const { ctx, admin } = await roles();
    const ollamaServer = await ollama(),
      openAi = await ollama({ openAiOnly: true });
    sockets(ctx, []);
    const behavior = {
      preset: "custom",
      instructions: "Sen deneyimli bir sistem yöneticisisin.",
      language: "tr",
      creativity: 0,
      length: "short",
      memory: "8k",
      repetition: 100,
    };
    for (const server of [ollamaServer, openAi]) {
      await admin.request("PUT", "/api/ai-agents/local", {
        body: {
          ...agentDefaults("local"),
          mode: "external",
          baseUrl: `http://127.0.0.1:${server.port}`,
          apiModel: "qwen3:0.6b",
          model: "qwen3:0.6b",
          behavior,
        },
      });
      const thread = await json<AiConversation>(
        await admin.post("/api/ai-agents/local/conversations", {}),
      );
      expect(
        await (
          await admin.post("/api/ai-agents/local/chat", {
            conversationId: thread.id,
            content: "Disk dolu",
          })
        ).text(),
      ).toContain("event: complete");
    }
    const system = {
      role: "system",
      content:
        "Sen deneyimli bir sistem yöneticisisin.\n\nKeep every answer short: a few sentences at most.\n\nAlways reply in Turkish, even if the user writes in another language.",
    };
    expect(ollamaServer.requests.find((entry) => entry.path === "/api/chat")?.body).toMatchObject({
      messages: [system, { role: "user", content: "Disk dolu" }],
      options: { temperature: 0.1, num_predict: 300, repeat_penalty: 1.3, num_ctx: 8192 },
    });
    expect(
      openAi.requests.find((entry) => entry.path === "/v1/chat/completions")?.body,
    ).toMatchObject({
      messages: [system, { role: "user", content: "Disk dolu" }],
      temperature: 0.1,
      max_tokens: 300,
      frequency_penalty: 0.8,
    });
    // A save that omits the behavior keeps it; agents never store one.
    const stored = await json<AiAgentView>(await admin.get("/api/ai-agents/local"));
    await admin.request("PUT", "/api/ai-agents/local", {
      body: { ...stored.settings, behavior: undefined },
    });
    expect(
      (await json<AiAgentView>(await admin.get("/api/ai-agents/local"))).settings.behavior,
    ).toEqual(behavior);
    await admin.request("PUT", "/api/ai-agents/hermes", {
      body: {
        ...agentDefaults("hermes"),
        mode: "external",
        baseUrl: "http://127.0.0.1:9",
        gatewayKey: "key",
        behavior,
      },
    });
    expect(
      (await json<AiAgentView>(await admin.get("/api/ai-agents/hermes"))).settings.behavior,
    ).toBeUndefined();
  });

  it("previews unsaved behavior on the saved local model without storing anything", async () => {
    const { ctx, admin, viewer } = await roles();
    const server = await ollama();
    sockets(ctx, []);
    const behavior = { ...DEFAULT_LOCAL_BEHAVIOR, language: "en", creativity: 100 };
    const preview = () =>
      admin.post("/api/ai-agents/local/preview", { behavior, prompt: "Introduce yourself." });
    expect((await preview()).status).toBe(409);
    await admin.request("PUT", "/api/ai-agents/local", {
      body: {
        ...agentDefaults("local"),
        mode: "external",
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiModel: "qwen3:0.6b",
        model: "qwen3:0.6b",
      },
    });
    expect(
      (
        await viewer.post("/api/ai-agents/local/preview", {
          behavior,
          prompt: "Introduce yourself.",
        })
      ).status,
    ).toBe(403);
    const stream = await (await preview()).text();
    expect(stream).toContain("event: delta");
    expect(stream).toContain('"answer":"Yerel yanıt"');
    expect(server.requests.find((entry) => entry.path === "/api/chat")?.body).toMatchObject({
      options: { temperature: 1.2 },
    });
    expect(
      (
        await json<{ conversations: AiConversation[] }>(
          await admin.get("/api/ai-agents/local/conversations"),
        )
      ).conversations,
    ).toEqual([]);
    // The saved behavior did not change.
    expect(
      (await json<AiAgentView>(await admin.get("/api/ai-agents/local"))).settings.behavior,
    ).toBeUndefined();
  });

  it("pulls and deletes models only after confirming a server EveryOS did not install", async () => {
    const { ctx, admin } = await roles();
    const server = await ollama();
    sockets(ctx, [{ port: server.port, address: "127.0.0.1", process: "ollama" }]);
    const id = `port:${server.port}`;
    expect(
      (await admin.post(`/api/ai-agents/local-models/servers/${id}/pull`, { model: "gemma3:1b" }))
        .status,
    ).toBe(422);
    const started = await admin.post(`/api/ai-agents/local-models/servers/${id}/pull`, {
      model: "gemma3:1b",
      confirmExternal: true,
    });
    expect(started.status).toBe(202);
    const { pull } = await json<{ pull: LocalModelPull }>(started);
    await vi.waitFor(async () =>
      expect((await view(admin)).pulls.find((entry) => entry.id === pull.id)).toMatchObject({
        state: "succeeded",
        status: "success",
        completed: 100,
        total: 100,
      }),
    );
    expect(server.models.has("gemma3:1b")).toBe(true);
    const failed = await json<{ pull: LocalModelPull }>(
      await admin.post(`/api/ai-agents/local-models/servers/${id}/pull`, {
        model: "missing:latest",
        confirmExternal: true,
      }),
    );
    await vi.waitFor(async () =>
      expect((await view(admin)).pulls.find((entry) => entry.id === failed.pull.id)).toMatchObject({
        state: "failed",
        error: "pull model manifest: file does not exist",
      }),
    );
    // Malformed names never reach the server.
    expect(
      (
        await admin.post(`/api/ai-agents/local-models/servers/${id}/pull`, {
          model: "../etc/passwd",
          confirmExternal: true,
        })
      ).status,
    ).toBe(400);
    const remove = (body: Record<string, unknown>) =>
      admin.request("DELETE", `/api/ai-agents/local-models/servers/${id}/models`, { body });
    expect(
      (await remove({ model: "gemma3:1b", confirm: "other", confirmExternal: true })).status,
    ).toBe(422);
    expect((await remove({ model: "gemma3:1b", confirm: "gemma3:1b" })).status).toBe(422);
    expect(
      (await remove({ model: "gemma3:1b", confirm: "gemma3:1b", confirmExternal: true })).status,
    ).toBe(204);
    expect(server.models.has("gemma3:1b")).toBe(false);
    expect(
      (await remove({ model: "gemma3:1b", confirm: "gemma3:1b", confirmExternal: true })).status,
    ).toBe(404);
    expect(
      ctx.db
        .all<{ action: string }>("SELECT action FROM audit_events WHERE action LIKE 'ai-local.%'")
        .map((row) => row.action)
        .sort(),
    ).toEqual(["ai-local.model-delete", "ai-local.model-pull", "ai-local.model-pull"]);
  });

  it("installs one system-wide EveryOS Ollama and gates GPU acceleration on hardware and administrators", async () => {
    const { ctx, admin } = await roles();
    expect(
      (
        await admin.post("/api/ai-agents/local-models/ollama", {
          acceleration: "nvidia",
          confirm: "ollama",
        })
      ).status,
    ).toBe(409);
    const status = await ctx.agent.call("docker.status", {}, { kind: "system", component: "test" });
    ctx.agent.handlers.set("docker.status", () => ({
      ...status,
      gpu: { nvidia: true, amd: false },
    }));
    // Host facts are cached for a minute; installation itself always reads them afresh.
    expect((await view(admin)).ollama.hardware).toEqual({ nvidia: false, amd: false });
    ctx.clock.now += 61_000;
    expect((await view(admin)).ollama.hardware).toEqual({ nvidia: true, amd: false });
    // A failed deployment never shows its acceleration as applied.
    let deploys = false;
    ctx.agent.handlers.set("apps.run", () => ({
      source: "simulated",
      ok: deploys,
      rollback: deploys ? "not-needed" : "succeeded",
    }));
    const failing = await json<{ job: AppJobView }>(
      await admin.post("/api/ai-agents/local-models/ollama", {
        acceleration: "nvidia",
        confirm: "ollama",
      }),
    );
    await vi.waitFor(() => expect(ctx.services.apps.job(failing.job.id)?.stage).toBe("failed"));
    expect((await view(admin)).ollama.acceleration).toBe("cpu");
    await removeOllama(ctx);
    deploys = true;
    // GPU access is a hardware risk that only administrators approve.
    const installed = await admin.post("/api/ai-agents/local-models/ollama", {
      acceleration: "nvidia",
      confirm: "ollama",
    });
    expect(installed.status).toBe(202);
    const { job } = await json<{ job: AppJobView }>(installed);
    await vi.waitFor(() =>
      expect(ctx.services.apps.job(job.id)?.stage).toMatch(/succeeded|failed/),
    );
    expect(ctx.services.apps.job(job.id)).toMatchObject({ stage: "succeeded" });
    const local = await view(admin);
    expect(local.ollama).toMatchObject({ acceleration: "nvidia", app: { id: job.appId } });
    expect(local.ollama.app?.provenance).toMatchObject({ path: "ollama" });
    // A managed Hermes may now use it over the internal network.
    const hermes = {
      ...agentDefaults("hermes"),
      provider: "ollama",
      model: "qwen3:0.6b",
    };
    expect((await admin.request("PUT", "/api/ai-agents/hermes", { body: hermes })).status).toBe(
      200,
    );
  });

  it("saves a chat on the EveryOS Ollama before installation and lists native servers without Docker", async () => {
    const { ctx, admin } = await roles();
    const settings = {
      ...agentDefaults("local"),
      mode: "managed",
      apiModel: "qwen3:0.6b",
      model: "qwen3:0.6b",
    };
    expect((await admin.request("PUT", "/api/ai-agents/local", { body: settings })).status).toBe(
      200,
    );
    expect((await json<AiAgentView>(await admin.get("/api/ai-agents/local"))).status).toBe(
      "not-installed",
    );
    const native = await ollama();
    sockets(ctx, [{ port: native.port, address: "127.0.0.1", process: "ollama" }]);
    ctx.agent.handlers.set("docker.containers.list", () => {
      throw new Error("Docker is not installed");
    });
    const result = await view(admin);
    expect(result.ollama.app).toBeNull();
    expect(result.servers.map((server) => server.id)).toEqual([`port:${native.port}`]);
    // The EveryOS Ollama might exist; without Docker its chat is reported unreachable.
    expect((await json<AiAgentView>(await admin.get("/api/ai-agents/local"))).status).toBe(
      "offline",
    );
  });

  it("starts only one EveryOS Ollama setup at a time", async () => {
    const { admin } = await roles();
    const body = { acceleration: "cpu", confirm: "ollama" };
    const statuses = (
      await Promise.all([
        admin.post("/api/ai-agents/local-models/ollama", body),
        admin.post("/api/ai-agents/local-models/ollama", body),
      ])
    ).map((response) => response.status);
    expect(statuses.sort()).toEqual([202, 409]);
  });

  it("refuses a managed agent on the EveryOS Ollama before it is installed", async () => {
    const { admin } = await roles();
    const response = await admin.request("PUT", "/api/ai-agents/hermes", {
      body: { ...agentDefaults("hermes"), provider: "ollama", model: "qwen3:0.6b" },
    });
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      error: { details: { reason: "ollama-missing" } },
    });
  });
});

describe("local model templates", () => {
  it("pins Ollama, keeps it on loopback and the AI network, and flags only GPU access", () => {
    const cpu = ollamaTemplate("cpu"),
      nvidia = ollamaTemplate("nvidia"),
      amd = ollamaTemplate("amd");
    expect(cpu.blockers).toEqual([]);
    expect(cpu.risks).toEqual([]);
    expect(nvidia.risks).toEqual(["devices"]);
    expect(amd.risks).toEqual(["devices"]);
    expect(amd.architectures).toEqual(["amd64"]);
    expect(cpu.architectures).toEqual(["amd64", "arm64"]);
    const doc = parseCompose(cpu.compose);
    expect(doc["x-otuken-ai-network"]).toEqual({ ollama: "everyos-ollama" });
    const service = (doc.services as Record<string, Record<string, unknown>>).ollama!;
    expect(service.image).toMatch(/^ollama\/ollama@sha256:[a-f0-9]{64}$/);
    expect(service.ports).toEqual([{ target: 11434, host_ip: "127.0.0.1", protocol: "tcp" }]);
    expect(JSON.stringify(service)).not.toMatch(/docker\.sock|privileged/);
  });

  it("lets managed agents reach the host and, for the EveryOS Ollama, the AI network", () => {
    const custom = parseCompose(
      agentTemplate("hermes", { ...agentDefaults("hermes"), model: "m" }, "gateway", "provider")
        .compose,
    );
    expect(custom["x-otuken-ai-network"]).toBeUndefined();
    expect(
      (custom.services as Record<string, Record<string, unknown>>).hermes!.extra_hosts,
    ).toEqual(["host.docker.internal:host-gateway"]);
    const local = agentTemplate(
      "openclaw",
      {
        ...agentDefaults("openclaw"),
        provider: "ollama",
        providerUrl: "http://everyos-ollama:11434/v1",
        model: "qwen3:0.6b",
      },
      "gateway",
      "",
    );
    expect(local.risks).toEqual(["default-secret"]);
    expect(parseCompose(local.compose)["x-otuken-ai-network"]).toEqual({ openclaw: null });
    expect(local.compose).toContain("http://everyos-ollama:11434/v1");
  });
});
