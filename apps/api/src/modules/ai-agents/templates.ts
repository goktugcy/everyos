import { createHash } from "node:crypto";
import { inspectCompose } from "@everyos/catalogs";
import { CONFIG_PLACEHOLDER } from "@everyos/catalogs/compose";
import type { AiAgentKind, AiAgentSettings, CatalogApp } from "@everyos/shared";
import { stringify } from "yaml";

export const AGENT_CATALOG_ID = "2d17f74b-a6bf-4bc1-a6e0-cece08c09f07";
// Official multi-architecture stable images, resolved on 2026-10-14. No moving tags.
export const AGENT_IMAGES: Record<AiAgentKind, string> = {
  hermes:
    "nousresearch/hermes-agent@sha256:c69536a39e885b8943329bda68cdf44492458b96aa74a212239bde9d2aeb406a",
  openclaw:
    "ghcr.io/openclaw/openclaw@sha256:70b8dbd23f8d27a206f43f9828fdebc87289e50d56dc55177354c9270d764026",
};
export const AGENT_PORTS: Record<AiAgentKind, number> = { hermes: 8642, openclaw: 18789 };
export const AGENT_MODELS: Record<AiAgentKind, string> = {
  hermes: "hermes-agent",
  openclaw: "openclaw/default",
};
export const PROVIDER_URLS = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
};
export function agentDefaults(kind: AiAgentKind): AiAgentSettings {
  return {
    mode: "managed",
    baseUrl: `http://127.0.0.1:${AGENT_PORTS[kind]}`,
    apiModel: AGENT_MODELS[kind],
    provider: "openrouter",
    providerUrl: PROVIDER_URLS.openrouter,
    model: "",
    tools: false,
    maxIterations: 30,
  };
}
export function agentTemplate(
  kind: AiAgentKind,
  settings: AiAgentSettings,
  gatewayKey: string,
  providerKey: string,
): CatalogApp {
  const name = kind === "hermes" ? "Hermes Agent" : "OpenClaw";
  const config =
    kind === "hermes"
      ? stringify({
          model: { provider: "custom", default: settings.model, base_url: settings.providerUrl },
          agent: { max_turns: settings.maxIterations },
          terminal: { backend: "local", cwd: "/opt/data" },
          platform_toolsets: {
            api_server: settings.tools ? ["terminal", "file", "web", "memory"] : [],
          },
        })
      : JSON.stringify({
          gateway: {
            mode: "local",
            bind: "lan",
            port: AGENT_PORTS.openclaw,
            auth: { mode: "token", token: gatewayKey },
            http: { endpoints: { chatCompletions: { enabled: true } } },
            controlUi: { enabled: false },
          },
          agents: {
            defaults: {
              model: { primary: `everyos/${settings.model}` },
              workspace: "/everyos-data/workspace",
              maxConcurrent: 1,
            },
          },
          models: {
            mode: "merge",
            providers: {
              everyos: {
                baseUrl: settings.providerUrl,
                apiKey: providerKey || "local",
                api: "openai-completions",
                models: [
                  {
                    id: settings.model,
                    name: settings.model,
                    input: ["text"],
                    contextWindow: 32768,
                    maxTokens: 4096,
                    reasoning: false,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
          tools: settings.tools
            ? { profile: "coding", elevated: { enabled: false } }
            : {
                profile: "minimal",
                deny: ["*"],
                toolSearch: false,
                elevated: { enabled: false },
              },
        });
  const environment =
    kind === "hermes"
      ? {
          API_SERVER_ENABLED: "true",
          API_SERVER_HOST: "0.0.0.0",
          API_SERVER_PORT: "8642",
          API_SERVER_MODEL_NAME: AGENT_MODELS.hermes,
          API_SERVER_KEY: gatewayKey,
          OPENAI_API_KEY: providerKey || "local",
          OPENAI_BASE_URL: settings.providerUrl,
        }
      : {
          OPENCLAW_GATEWAY_TOKEN: gatewayKey,
          OPENCLAW_STATE_DIR: "/everyos-data/state",
          OPENCLAW_CONFIG_PATH: "/run/everyos-agent.json",
          OPENCLAW_DISABLE_BONJOUR: "1",
        };
  const compose = stringify(
    {
      "x-otuken-files": [{ name: "config0", content: config.replaceAll("$", () => "$$") }],
      services: {
        [kind]: {
          image: AGENT_IMAGES[kind],
          ...(kind === "hermes"
            ? { command: ["gateway", "run"] }
            : {
                entrypoint: ["node"],
                command: ["dist/index.js", "gateway", "--bind", "lan", "--port", "18789"],
              }),
          restart: "unless-stopped",
          environment: Object.fromEntries(
            Object.entries(environment).map(([key, value]) => [
              key,
              value.replaceAll("$", () => "$$"),
            ]),
          ),
          ports: [{ target: AGENT_PORTS[kind], host_ip: "127.0.0.1", protocol: "tcp" }],
          volumes: [
            {
              type: "bind",
              source: "${APP_DATA_DIR}/",
              target: kind === "hermes" ? "/opt/data" : "/everyos-data",
            },
            {
              type: "bind",
              source: `${CONFIG_PLACEHOLDER}/config0`,
              target: kind === "hermes" ? "/opt/data/config.yaml" : "/run/everyos-agent.json",
              read_only: true,
            },
          ],
          security_opt: ["no-new-privileges:true"],
          cap_drop: ["NET_RAW", "NET_ADMIN"],
        },
      },
    },
    { lineWidth: 0 },
  );
  const inspected = inspectCompose(compose);
  const ref = createHash("sha256").update(AGENT_IMAGES[kind]).digest("hex");
  return {
    ...inspected,
    id: `${AGENT_CATALOG_ID}:${kind}`,
    nativeId: kind,
    logicalKey: `everyos.agent.${kind}`,
    name: { en: name, tr: name },
    description: {},
    categories: ["ai"],
    icon: null,
    version: ref.slice(0, 12),
    architectures: ["amd64", "arm64"],
    source: { catalogId: AGENT_CATALOG_ID, format: "compose-dir", ref, path: kind },
    variants: {},
    contentHash: ref,
    screenshots: [],
    links: { documentation: null, website: null, repository: null },
    notes: {},
    web: { path: "/", scheme: "http", service: kind, port: AGENT_PORTS[kind] },
    compose,
  };
}
