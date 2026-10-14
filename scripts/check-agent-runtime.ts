/** Runs only in disposable Linux CI: official pinned agents against a local fake model provider. */
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareInstall } from "../packages/catalogs/src/install.ts";
import { materializeConfigs } from "../apps/agent/src/managed-configs.ts";
import {
  agentDefaults,
  agentTemplate,
  AGENT_MODELS,
  AGENT_IMAGES,
} from "../apps/api/src/modules/ai-agents/templates.ts";
import { AI_AGENT_KINDS } from "../packages/shared/src/ai-agents.ts";
import { streamAgentChat } from "../apps/api/src/modules/ai-agents/chat-client.ts";
import { NativeAgents } from "../apps/agent/src/native-agents.ts";

if (process.platform !== "linux" || process.env.CI !== "true")
  throw new Error("This check is restricted to disposable Linux CI");
const root = await mkdtemp(join(tmpdir(), "everyos-agent-runtime-"));
async function privilegedFixture(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("sudo", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Disposable runtime state operation failed")),
    );
  });
}
const key = randomBytes(32).toString("hex");
const calls: Array<{ tools?: Array<{ function?: { name?: string } }>; model?: string }> = [];
const handle = async (request: IncomingMessage, response: ServerResponse) => {
  if (request.url === "/v1/models") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(404);
    response.end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const part of request) chunks.push(part as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString()) as {
    stream?: boolean;
    tools?: Array<{ function?: { name?: string } }>;
    model?: string;
  };
  calls.push(input);
  const base = {
    id: "chatcmpl-fixture",
    created: Math.floor(Date.now() / 1000),
    model: "fixture-model",
  };
  if (input.stream) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "runtime-smoke-ok" }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    response.end();
  } else {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        ...base,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "runtime-smoke-ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
    );
  }
};
const server = createServer((request, response) => {
  void handle(request, response).catch(() => response.destroy());
});
await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
const providerPort = (server.address() as AddressInfo).port;
async function command(args: string[], capture = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (capture) output += chunk.toString();
    });
    child.stderr.on("data", () => undefined);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`Docker ${args[0]} failed (${code})`)),
    );
  });
}
try {
  for (const kind of AI_AGENT_KINDS) {
    const id = randomUUID(),
      data = join(root, kind);
    await mkdir(data);
    await chmod(data, 0o777);
    const settings = {
      ...agentDefaults(kind),
      provider: "custom" as const,
      providerUrl: `http://host.docker.internal:${providerPort}/v1`,
      model: "fixture-model",
      tools: false,
    };
    const template = agentTemplate(kind, settings, key, "fixture-provider-key");
    const prepared = prepareInstall(template, id, { variables: {}, ports: [] }).replaceAll(
      "{{otuken.appData}}",
      data,
    );
    let compose = await materializeConfigs(prepared, id, false);
    // Test-only hostname for the fake provider; the deployed template is otherwise identical.
    compose = compose.replace(
      "restart: unless-stopped",
      'restart: unless-stopped\n    extra_hosts: ["host.docker.internal:host-gateway"]',
    );
    const file = join(root, `${kind}.yaml`);
    await writeFile(file, compose, { mode: 0o600 });
    const project = `everyos-runtime-${id.replaceAll("-", "")}`,
      cli = ["compose", "-p", project, "-f", file];
    try {
      console.log(`${kind}: pulling ${AGENT_IMAGES[kind]}`);
      await command([...cli, "up", "-d", "--pull", "always"]);
      const mapping = await command(
        [...cli, "port", kind, String(kind === "hermes" ? 8642 : 18789)],
        true,
      );
      const port = mapping.trim().split(":").at(-1);
      if (!port || !/^\d+$/.test(port)) throw new Error("Missing assigned loopback port");
      const baseUrl = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let attempt = 0; attempt < 90; attempt++) {
        try {
          const response = await fetch(`${baseUrl}/v1/models`, {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* Container may still be initializing. */
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!ready) throw new Error(`${kind}: API did not become ready`);
      calls.length = 0;
      const answer = await streamAgentChat({
        url: `${baseUrl}/v1/chat/completions`,
        key,
        model: AGENT_MODELS[kind],
        user: `everyos-smoke-${id}`,
        messages: [{ role: "user", content: "Reply with runtime-smoke-ok." }],
        signal: AbortSignal.timeout(120_000),
        onDelta: () => Promise.resolve(),
      });
      if (!answer.includes("runtime-smoke-ok") || !calls.length)
        throw new Error(`${kind}: runtime did not call the configured model provider`);
      if (calls.some((call) => call.tools?.length))
        throw new Error(`${kind}: tools-off configuration still exposes tools`);
      console.log(
        `${kind}: real API, configured model, streamed answer and disabled tools verified`,
      );
      await command([...cli, "down", "--remove-orphans"]);
      await privilegedFixture(["chown", "-R", `${process.getuid!()}:${process.getgid!()}`, data]);
      const nativeHome = join(root, `${kind}-native-home`),
        nativeRoot = join(nativeHome, kind === "hermes" ? ".hermes" : ".openclaw");
      await mkdir(nativeHome);
      await rename(kind === "hermes" ? data : join(data, "state"), nativeRoot);
      await writeFile(
        join(nativeRoot, kind === "hermes" ? "config.yaml" : "openclaw.json"),
        await readFile(`/run/everyos/app-configs/${id}/config0`),
        { mode: 0o600 },
      );
      if (kind === "hermes")
        await writeFile(join(nativeRoot, ".env"), `API_SERVER_KEY=${key}\n`, { mode: 0o600 });
      const snapshot = await new NativeAgents(nativeHome).snapshot(kind, true);
      const history = snapshot.conversations.flatMap((chat) => chat.messages);
      if (
        snapshot.gatewayKey !== key ||
        !history.some(
          (message) => message.role === "user" && message.content.includes("runtime-smoke-ok"),
        ) ||
        !history.some(
          (message) => message.role === "assistant" && message.content.includes("runtime-smoke-ok"),
        )
      )
        throw new Error(`${kind}: native reader did not recover actual runtime settings/history`);
      console.log(`${kind}: actual native settings and persisted SQLite chat recovered read-only`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Runtime check failed");
      console.error(
        "Provider tool names:",
        calls.map((call) => call.tools?.map((tool) => tool.function?.name) ?? []),
      );
      const logs = await command([...cli, "logs", "--no-color", "--tail", "100"], true).catch(
        () => "",
      );
      console.error(
        logs.replaceAll(key, "[REDACTED]").replaceAll("fixture-provider-key", "[REDACTED]"),
      );
      throw error;
    } finally {
      await command([...cli, "down", "--remove-orphans"]).catch(() => undefined);
      await rm(`/run/everyos/app-configs/${id}`, { recursive: true, force: true });
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // The official images create private state with their own container UID.
  await privilegedFixture(["rm", "-rf", "--", root]);
}
