import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { parseEnv } from "node:util";
import JSON5 from "json5";
import { parse as parseYaml } from "yaml";
import { OperationError, type OperationHandlers } from "@everyos/agent-protocol";
import type {
  AiAgentDiscovery,
  AiAgentSettings,
  AiChatMessage,
  NativeAgentSnapshot,
} from "@everyos/shared";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const secret = (value: unknown) =>
  typeof value === "string" && value.length <= 4096 && !/[\r\n\0]/.test(value) ? value : "";
const stamp = (value: unknown) => {
  const ms = Math.trunc(
    typeof value === "number"
      ? value < 1e12
        ? value * 1000
        : value
      : typeof value === "string"
        ? Date.parse(value)
        : 0,
  );
  // Hermes stores fractional epoch seconds; EveryOS keeps integer milliseconds.
  return Number.isSafeInteger(ms) && ms > 0 ? ms : 0;
};
function message(raw: unknown): AiChatMessage | null {
  const record = object(raw),
    inner = Object.keys(object(record.message)).length ? object(record.message) : record;
  if (inner.role !== "user" && inner.role !== "assistant") return null;
  const content =
    typeof inner.content === "string"
      ? inner.content
      : Array.isArray(inner.content)
        ? inner.content
            .map((part) => (object(part).type === "text" ? text(object(part).text) : ""))
            .filter(Boolean)
            .join("\n")
        : "";
  if (!content.trim()) return null;
  return { role: inner.role, content: content.slice(0, 32_000) };
}

/** Fixed upstream layouts only. This reader always runs as the bound account, never as root. */
export class NativeAgents {
  readonly #home: string;
  constructor(home: string) {
    this.#home = home;
  }
  #root(id: string): string {
    const [kind, profile] = id.split(":");
    if (!/^(hermes|openclaw|clawdbot)(?::[A-Za-z0-9_-]{1,64})?$/.test(id))
      throw new OperationError("invalid_params", "Invalid native agent candidate");
    return kind === "hermes"
      ? join(this.#home, ".hermes", ...(profile ? ["profiles", profile] : []))
      : join(
          this.#home,
          kind === "clawdbot" ? ".clawdbot" : profile ? `.openclaw-${profile}` : ".openclaw",
        );
  }
  async #safe(root: string, relative: string): Promise<string> {
    const path = join(root, relative);
    if ((await realpath(root)) !== root || (await realpath(path)) !== path)
      throw new OperationError("policy_denied", "Native agent paths must not be symbolic links");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new OperationError("policy_denied", "Unsafe native agent file");
    return path;
  }
  async #read(root: string, relative: string, maxBytes = 128 * 1024): Promise<string> {
    const path = await this.#safe(root, relative),
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat(),
        current = await lstat(path);
      if (info.ino !== current.ino || info.dev !== current.dev || info.size > maxBytes)
        throw new OperationError("invalid_params", "Native agent file exceeds the read limit");
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  }
  async #optional(root: string, relative: string): Promise<string> {
    try {
      return await this.#read(root, relative);
    } catch {
      return "";
    }
  }
  async #history(
    root: string,
    kind: "hermes" | "openclaw",
  ): Promise<{
    conversations: NativeAgentSnapshot["conversations"];
    warning: AiAgentDiscovery["historyWarning"];
  }> {
    const conversations: NativeAgentSnapshot["conversations"] = [];
    let warning: AiAgentDiscovery["historyWarning"] = null;
    const add = (id: string, rows: unknown[], updatedAt: number) => {
      const messages = rows
        .map(message)
        .filter((item): item is AiChatMessage => item !== null)
        .slice(-40);
      while (messages.at(0)?.role === "assistant") messages.shift();
      if (!messages.length || conversations.length >= 20) return;
      // Keep imported contexts within the same limit used for native EveryOS chat.
      while (Buffer.byteLength(JSON.stringify(messages)) > 120 * 1024) messages.shift();
      while (messages.at(0)?.role === "assistant") messages.shift();
      if (!messages.length) return;
      conversations.push({
        sourceId: id.slice(0, 250),
        messages,
        updatedAt,
        truncated: rows.length > messages.length,
      });
    };
    const databases =
      kind === "hermes"
        ? ["state.db"]
        : (await readdir(join(root, "agents")).catch(() => [] as string[]))
            .filter((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))
            .slice(0, 10)
            .map((name) => `agents/${name}/agent/openclaw-agent.sqlite`);
    for (const relative of databases) {
      let db: DatabaseSync | null = null;
      try {
        const path = await this.#safe(root, relative);
        if ((await lstat(path)).size > 256 * 1024 * 1024) {
          warning = "limited";
          continue;
        }
        db = new DatabaseSync(path, {
          readOnly: true,
          enableForeignKeyConstraints: false,
          allowExtension: false,
        });
        db.exec("PRAGMA trusted_schema = OFF");
        if (kind === "hermes") {
          const sessions = db
            .prepare("SELECT id, started_at FROM sessions ORDER BY started_at DESC LIMIT 21")
            .all() as Array<{ id: string; started_at: number }>;
          for (const session of sessions.slice(0, 20)) {
            const rows = db
              .prepare(
                "SELECT role, content FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 41",
              )
              .all(session.id);
            add(session.id, rows.reverse(), stamp(session.started_at));
          }
          if (sessions.length > 20) warning = "limited";
        } else {
          const sessions = db
            .prepare("SELECT DISTINCT session_id FROM session_transcript_active_events LIMIT 21")
            .all() as Array<{ session_id: string }>;
          for (const session of sessions.slice(0, 20)) {
            const rows = db
              .prepare(
                "SELECT event.event_json, event.event_zstd, event.event_utf8_bytes FROM session_transcript_active_events AS active JOIN transcript_events AS event ON event.session_id = active.session_id AND event.seq = active.event_seq WHERE active.session_id = ? AND active.message_position IS NOT NULL ORDER BY active.message_position DESC LIMIT 41",
              )
              .all(session.session_id) as Array<{
              event_json: string | null;
              event_zstd: Uint8Array | null;
              event_utf8_bytes: number | null;
            }>;
            const events: unknown[] = [];
            for (const row of rows.reverse()) {
              if ((row.event_utf8_bytes ?? 0) > 128 * 1024) {
                warning = "limited";
                continue;
              }
              const raw =
                row.event_json ??
                (row.event_zstd
                  ? zstdDecompressSync(row.event_zstd, { maxOutputLength: 128 * 1024 }).toString(
                      "utf8",
                    )
                  : "");
              if (Buffer.byteLength(raw) > 128 * 1024) {
                warning = "limited";
                continue;
              }
              events.push(JSON.parse(raw) as unknown);
            }
            add(
              `${relative}:${session.session_id}`,
              events,
              stamp(object(events.at(-1)).timestamp),
            );
          }
          if (sessions.length > 20) warning = "limited";
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") warning = "unsupported";
      } finally {
        db?.close();
      }
    }
    // Read-only support for archived/older JSONL transcripts, without rewriting their native store.
    const dirs =
      kind === "hermes"
        ? ["sessions"]
        : (await readdir(join(root, "agents")).catch(() => [] as string[]))
            .filter((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))
            .slice(0, 10)
            .map((name) => `agents/${name}/sessions`);
    if (!conversations.length)
      for (const dir of dirs) {
        const names = (await readdir(join(root, dir)).catch(() => [] as string[]))
          .filter((name) => /^[A-Za-z0-9_-]{1,200}\.jsonl$/.test(name))
          .sort()
          .slice(-20);
        for (const name of names) {
          try {
            const content = await this.#read(root, `${dir}/${name}`, 4 * 1024 * 1024);
            const rows = content
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as unknown);
            add(`${dir}/${name}`, rows, stamp(object(rows.at(-1)).timestamp));
          } catch {
            warning = "unreadable";
          }
        }
      }
    if (conversations.some((item) => item.truncated)) warning = "limited";
    return { conversations, warning };
  }
  async snapshot(id: string, includeHistory: boolean): Promise<NativeAgentSnapshot> {
    const root = this.#root(id),
      kind = id.startsWith("hermes") ? "hermes" : "openclaw";
    const envRaw = await this.#optional(root, ".env"),
      env = parseEnv(envRaw);
    const raw = await this.#read(
      root,
      kind === "hermes"
        ? "config.yaml"
        : id.startsWith("clawdbot")
          ? "clawdbot.json"
          : "openclaw.json",
    );
    const doc = object(
      kind === "hermes"
        ? parseYaml(raw, { maxAliasCount: 20, uniqueKeys: true })
        : JSON5.parse<unknown>(raw),
    );
    const resolveSecret = (value: unknown) => {
      const direct = secret(value);
      const ref = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(direct);
      const reference = object(value);
      return ref
        ? secret(env[ref[1]!])
        : reference.source === "env"
          ? secret(env[text(reference.id)])
          : direct;
    };
    const model = object(doc.model),
      gateway = object(doc.gateway),
      auth = object(gateway.auth);
    const primary = text(object(object(object(doc.agents).defaults).model).primary);
    const provider = object(object(object(doc.models).providers)[primary.split("/")[0] ?? ""]);
    const gatewayKey =
      kind === "hermes"
        ? secret(env.API_SERVER_KEY) ||
          resolveSecret(object(object(object(doc.platforms).api_server).extra).api_key)
        : auth.mode === "password"
          ? resolveSecret(auth.password) || secret(env.OPENCLAW_GATEWAY_PASSWORD)
          : resolveSecret(auth.token) || secret(env.OPENCLAW_GATEWAY_TOKEN);
    const providerKey =
      kind === "hermes"
        ? secret(env.OPENAI_API_KEY) ||
          secret(env.OPENROUTER_API_KEY) ||
          resolveSecret(model.api_key)
        : resolveSecret(provider.apiKey) ||
          secret(env.OPENAI_API_KEY) ||
          secret(env.OPENROUTER_API_KEY);
    const providerUrl =
      kind === "hermes"
        ? text(model.base_url) || env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1"
        : text(provider.baseUrl) || "https://api.openai.com/v1";
    const port = Number(
      kind === "hermes"
        ? env.API_SERVER_PORT || object(object(doc.platforms).api_server).port || 8642
        : gateway.port || env.OPENCLAW_GATEWAY_PORT || 18789,
    );
    const settings: AiAgentSettings = {
      mode: "external",
      baseUrl: `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port <= 65535 ? port : kind === "hermes" ? 8642 : 18789}`,
      apiModel:
        kind === "hermes"
          ? secret(env.API_SERVER_MODEL_NAME) || (id.split(":")[1] ?? "hermes-agent")
          : "openclaw/default",
      provider: "custom",
      providerUrl: /^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/.test(providerUrl)
        ? providerUrl
        : "https://api.openai.com/v1",
      model: (kind === "hermes"
        ? text(model.default)
        : primary.split("/").slice(1).join("/")
      ).slice(0, 200),
      tools: false,
      maxIterations: 30,
    };
    if (kind === "hermes" && id.includes(":")) settings.baseUrl += `/p/${id.split(":")[1]!}`;
    const history = includeHistory
      ? await this.#history(root, kind)
      : { conversations: [], warning: null };
    const fingerprint = createHash("sha256").update(id).update(raw).update(envRaw).digest("hex");
    return {
      discovery: {
        id,
        kind,
        source: "native",
        name: id,
        fingerprint,
        baseUrl: settings.baseUrl,
        apiModel: settings.apiModel,
        canImport: true,
        hasGatewayKey: Boolean(gatewayKey),
        hasProviderKey: Boolean(providerKey),
        historyCount: history.conversations.length,
        historyWarning: history.warning,
      },
      settings,
      gatewayKey: gatewayKey || null,
      providerKey: providerKey || null,
      conversations: history.conversations,
    };
  }
  async discover(): Promise<AiAgentDiscovery[]> {
    const ids = ["hermes", "openclaw", "clawdbot"];
    const profiles = await readdir(join(this.#home, ".hermes", "profiles")).catch(
      () => [] as string[],
    );
    ids.push(
      ...profiles
        .filter((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))
        .slice(0, 10)
        .map((name) => `hermes:${name}`),
    );
    const homes = await readdir(this.#home).catch(() => [] as string[]);
    ids.push(
      ...homes
        .filter((name) => /^\.openclaw-[A-Za-z0-9_-]{1,64}$/.test(name))
        .slice(0, 10)
        .map((name) => `openclaw:${name.slice(10)}`),
    );
    const discoveries: AiAgentDiscovery[] = [];
    for (const id of ids) {
      try {
        discoveries.push((await this.snapshot(id, true)).discovery);
      } catch {
        if (id !== "hermes" && id !== "openclaw") continue;
        const binary = id === "hermes" ? "hermes" : "openclaw";
        const dirs = [
          join(this.#home, ".local", "bin"),
          join(this.#home, ".npm-global", "bin"),
          ...(process.platform === "linux" ? ["/usr/local/bin", "/usr/bin"] : []),
        ];
        let installed = false;
        for (const dir of dirs) {
          try {
            await access(join(dir, binary), constants.X_OK);
            installed = true;
            break;
          } catch {
            /* Probe only fixed executable locations; never execute them. */
          }
        }
        if (installed)
          discoveries.push({
            id,
            kind: id,
            source: "native",
            name: id,
            fingerprint: createHash("sha256").update(`binary:${id}`).digest("hex"),
            baseUrl: `http://127.0.0.1:${id === "hermes" ? 8642 : 18789}`,
            apiModel: id === "hermes" ? "hermes-agent" : "openclaw/default",
            canImport: false,
            hasGatewayKey: false,
            hasProviderKey: false,
            historyCount: 0,
            historyWarning: "unreadable",
          });
      }
    }
    return discoveries;
  }
}

export function accountNativeAgents(
  home: string,
): Pick<OperationHandlers, "ai.discover" | "ai.snapshot"> {
  const reader = new NativeAgents(home);
  return {
    "ai.discover": async () => ({ source: "host", discoveries: await reader.discover() }),
    "ai.snapshot": async ({ id, fingerprint, includeHistory }) => {
      const result = await reader.snapshot(id, includeHistory);
      if (result.discovery.fingerprint !== fingerprint)
        throw new OperationError("conflict", "Native agent settings changed; scan again");
      return result;
    },
  };
}
