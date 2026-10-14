import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { NativeAgentSnapshotSchema } from "@everyos/shared/schemas";
import { NativeAgents, accountNativeAgents } from "./native-agents.ts";

const homes: string[] = [];
async function home() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "everyos-native-agents-")));
  homes.push(path);
  return path;
}
afterEach(async () => {
  for (const path of homes.splice(0)) await rm(path, { recursive: true, force: true });
});
describe("native account agent discovery", () => {
  it("reads Hermes config, own environment and SQLite text history without modifying any native file", async () => {
    const root = await home(),
      data = join(root, ".hermes");
    await mkdir(data);
    const config =
      "model:\n  provider: custom\n  default: fixture-native-model\n  base_url: http://127.0.0.1:8000/v1\n";
    const env =
      "API_SERVER_ENABLED=true\nAPI_SERVER_KEY='native-gateway-secret'\nOPENAI_API_KEY=native-model-secret\nAPI_SERVER_PORT=8649\n";
    await writeFile(join(data, "config.yaml"), config);
    await writeFile(join(data, ".env"), env);
    const db = new DatabaseSync(join(data, "state.db"));
    db.exec(
      "CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT);",
    );
    // Hermes records fractional epoch seconds.
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run("native-session", 1791325313.5494144);
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run(
      1,
      "native-session",
      "user",
      "native private question",
    );
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run(
      2,
      "native-session",
      "tool",
      "tool output omitted",
    );
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run(
      3,
      "native-session",
      "assistant",
      "native answer",
    );
    db.close();
    const before = await readFile(join(data, "state.db")),
      reader = new NativeAgents(root);
    const discoveries = await reader.discover();
    expect(discoveries).toHaveLength(1);
    expect(discoveries[0]).toMatchObject({
      kind: "hermes",
      historyCount: 1,
      hasGatewayKey: true,
      baseUrl: "http://127.0.0.1:8649",
    });
    expect(JSON.stringify(discoveries)).not.toContain("native-gateway-secret");
    expect(JSON.stringify(discoveries)).not.toContain("native private question");
    const snapshot = await reader.snapshot("hermes", true);
    NativeAgentSnapshotSchema.parse(snapshot);
    expect(snapshot.gatewayKey).toBe("native-gateway-secret");
    expect(snapshot.providerKey).toBe("native-model-secret");
    expect(snapshot.conversations[0]?.updatedAt).toBe(1791325313549);
    expect(snapshot.conversations[0]?.messages).toEqual([
      { role: "user", content: "native private question" },
      { role: "assistant", content: "native answer" },
    ]);
    expect(await readFile(join(data, "state.db"))).toEqual(before);
    expect(await readFile(join(data, "config.yaml"), "utf8")).toBe(config);
    expect(await readFile(join(data, ".env"), "utf8")).toBe(env);
  });
  it("reads JSON5 OpenClaw settings and the active SQLite transcript including bounded zstd payloads", async () => {
    const root = await home(),
      data = join(root, ".openclaw"),
      agent = join(data, "agents", "main", "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(
      join(data, "openclaw.json"),
      `{ // native JSON5
      gateway: {mode: 'local', port: 18799, auth: {mode: 'token', token: '\${OPENCLAW_GATEWAY_TOKEN}'},},
      agents: {defaults: {model: {primary: 'native/fixture-model'}}},
      models: {providers: {native: {baseUrl: 'http://127.0.0.1:8010/v1', apiKey: {source: 'env', id: 'NATIVE_MODEL_KEY'}}}},
    }`,
    );
    await writeFile(
      join(data, ".env"),
      "OPENCLAW_GATEWAY_TOKEN=native-claw-token\nNATIVE_MODEL_KEY=native-provider-key\n",
    );
    const db = new DatabaseSync(join(agent, "openclaw-agent.sqlite"));
    db.exec(
      "CREATE TABLE session_transcript_active_events(session_id TEXT, event_seq INTEGER, message_position INTEGER); CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB, event_utf8_bytes INTEGER);",
    );
    const events = [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "existing question" }] },
      },
      {
        type: "message",
        timestamp: "2026-10-14T12:00:00Z",
        message: { role: "assistant", content: [{ type: "text", text: "existing answer" }] },
      },
    ];
    for (const [index, event] of events.entries()) {
      const value = JSON.stringify(event);
      db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)").run(
        "claw-session",
        index,
        index ? null : value,
        index ? zstdCompressSync(Buffer.from(value)) : null,
        Buffer.byteLength(value),
      );
      db.prepare("INSERT INTO session_transcript_active_events VALUES (?, ?, ?)").run(
        "claw-session",
        index,
        index,
      );
    }
    db.close();
    const reader = new NativeAgents(root),
      snapshot = await reader.snapshot("openclaw", true);
    NativeAgentSnapshotSchema.parse(snapshot);
    expect(snapshot.discovery.historyCount).toBe(1);
    expect(snapshot.settings).toMatchObject({
      model: "fixture-model",
      providerUrl: "http://127.0.0.1:8010/v1",
      baseUrl: "http://127.0.0.1:18799",
    });
    expect(snapshot.gatewayKey).toBe("native-claw-token");
    expect(snapshot.providerKey).toBe("native-provider-key");
    expect(snapshot.conversations[0]?.messages).toEqual([
      { role: "user", content: "existing question" },
      { role: "assistant", content: "existing answer" },
    ]);
  });
  it("finds named profiles and rejects symlink escapes, unknown paths and settings changed after discovery", async () => {
    const root = await home(),
      outside = await home();
    await mkdir(join(outside, ".hermes"));
    await writeFile(join(outside, ".hermes", "config.yaml"), "model: {default: private}\n");
    await symlink(join(outside, ".hermes"), join(root, ".hermes"));
    expect(await new NativeAgents(root).discover()).toEqual([]);
    await rm(join(root, ".hermes"));
    await mkdir(join(root, ".hermes", "profiles", "work"), { recursive: true });
    await writeFile(
      join(root, ".hermes", "profiles", "work", "config.yaml"),
      "model: {default: work-model}\n",
    );
    const handlers = accountNativeAgents(root),
      reader = new NativeAgents(root);
    const candidates = await reader.discover();
    expect(candidates[0]?.id).toBe("hermes:work");
    await expect(reader.snapshot("../../other", true)).rejects.toThrow("Invalid native agent");
    await writeFile(
      join(root, ".hermes", "profiles", "work", "config.yaml"),
      "model: {default: changed}\n",
    );
    await expect(
      handlers["ai.snapshot"](
        { id: "hermes:work", fingerprint: candidates[0]!.fingerprint, includeHistory: false },
        {} as never,
      ),
    ).rejects.toThrow("scan again");
  });
});
