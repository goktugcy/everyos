import type { AppJobView, InstalledAppView } from "./catalogs.ts";

/** `local` is a direct chat with a local model server; the others are agent runtimes. */
export const AI_AGENT_KINDS = ["local", "hermes", "openclaw"] as const;
export const AI_AGENT_CATALOG_ID = "2d17f74b-a6bf-4bc1-a6e0-cece08c09f07";
export type AiAgentKind = (typeof AI_AGENT_KINDS)[number];
/** `ollama` is the EveryOS-installed Ollama, reached by managed agents over a private network. */
export const AI_PROVIDERS = ["openrouter", "openai", "ollama", "custom"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
/** Internal Docker network shared by EveryOS-installed AI apps only. */
export const EVERYOS_AI_NETWORK = "everyos-ai";
/** Base URL of the EveryOS Ollama inside that network. */
export const EVERYOS_OLLAMA_NETWORK_URL = "http://everyos-ollama:11434";
/** Fixed endpoints of the named providers; `custom` takes any URL. */
export const AI_PROVIDER_URLS: Record<Exclude<AiProvider, "custom">, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  ollama: `${EVERYOS_OLLAMA_NETWORK_URL}/v1`,
};
export const LOCAL_PRESETS = ["assistant", "concise", "teacher", "coder", "custom"] as const;
export type LocalPreset = (typeof LOCAL_PRESETS)[number];
export const LOCAL_LANGUAGES = ["auto", "tr", "en"] as const;
export const LOCAL_LENGTHS = ["short", "normal", "long"] as const;
/** Conversation memory (context window); applied by Ollama servers only. */
export const LOCAL_MEMORY = ["auto", "2k", "4k", "8k", "16k"] as const;
/** How a local model answers: what EveryOS sends with every direct chat request. */
export interface LocalBehavior {
  /** The preset the instructions came from; `custom` once edited. */
  preset: LocalPreset;
  /** System instructions. Empty uses EveryOS's default assistant instructions. */
  instructions: string;
  language: (typeof LOCAL_LANGUAGES)[number];
  /** 0 = consistent and factual … 100 = creative (sampling temperature). */
  creativity: number;
  length: (typeof LOCAL_LENGTHS)[number];
  memory: (typeof LOCAL_MEMORY)[number];
  /** 0 = off … 100 = strongly avoid repeating itself. */
  repetition: number;
}
export const DEFAULT_LOCAL_BEHAVIOR: LocalBehavior = {
  preset: "assistant",
  instructions: "",
  language: "auto",
  creativity: 30,
  length: "normal",
  memory: "auto",
  repetition: 30,
};
export interface AiAgentSettings {
  mode: "managed" | "external";
  baseUrl: string;
  apiModel: string;
  provider: AiProvider;
  providerUrl: string;
  model: string;
  maxIterations: number;
  tools: boolean;
  /** Local models only. */
  behavior?: LocalBehavior | undefined;
}
/** A model a chat uses. `provider` is the agent's own provider slug (Hermes), otherwise null. */
export interface AiModelRef {
  provider: string | null;
  model: string;
}
export interface AiAgentView {
  kind: AiAgentKind;
  configured: boolean;
  settings: AiAgentSettings;
  /** The model chats use, as far as EveryOS knows it; null means the agent's own default. */
  chatModel: AiModelRef | null;
  /** Hermes: the model was chosen in EveryOS and is sent with every request. */
  chatModelChosen: boolean;
  hasGatewayKey: boolean;
  hasProviderKey: boolean;
  app: InstalledAppView | null;
  status:
    | "unconfigured"
    | "not-installed"
    | "starting"
    | "running"
    | "stopped"
    | "offline"
    | "auth-failed"
    | "error"
    | "unknown";
  busy: boolean;
  source: "host" | "simulated";
  job: AppJobView | null;
}
export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Assistant answers: the model EveryOS asked for, when known. */
  model?: string | undefined;
}
/**
 * Open WebUI sends its background title/tag/follow-up generation through the same chat API as
 * single "### Task:" prompts. They are not conversations and are never imported.
 */
export function isOpenWebUiTask(content: string): boolean {
  return /^\s*###\s*Task:/i.test(content);
}
export interface AiConversation {
  id: string;
  kind: AiAgentKind;
  title: string;
  updatedAt: number;
  /** Favorites and archived chats are exclusive: archiving drops the favorite mark. */
  favorite: boolean;
  archived: boolean;
  messages: AiChatMessage[];
}
export type AiConversationSummary = Omit<AiConversation, "messages">;

/** Models a chat can switch to, grouped by the agent's providers. */
export interface AiModelGroup {
  /** Hermes provider slug; null for a single list (local server, managed OpenClaw provider). */
  provider: string | null;
  name: string;
  models: string[];
}
export interface AiModelCatalog {
  kind: AiAgentKind;
  /** The model chats use now; null when the agent did not say. */
  current: AiModelRef | null;
  /** Hermes's own configured model, used when no model is chosen in EveryOS. */
  agentDefault: AiModelRef | null;
  chosen: boolean;
  groups: AiModelGroup[];
  /**
   * `instant`: the next message uses the new model; `restart`: EveryOS rewrites the agent's
   * configuration and restarts it; `none`: EveryOS cannot change this agent's model.
   */
  switching: "instant" | "restart" | "none";
  /** Why the list is empty or switching is unavailable. */
  problem:
    "unconfigured" | "not-ready" | "offline" | "auth-failed" | "unsupported" | "external" | null;
  truncated: boolean;
}

export interface AiAgentDiscovery {
  id: string;
  kind: AiAgentKind;
  source: "native" | "container";
  name: string;
  fingerprint: string;
  baseUrl: string;
  apiModel: string;
  canImport: boolean;
  hasGatewayKey: boolean;
  hasProviderKey: boolean;
  historyCount: number;
  historyWarning: "limited" | "unreadable" | "unsupported" | null;
}
export const LOCAL_SERVER_KINDS = [
  "ollama",
  "lmstudio",
  "llamacpp",
  "vllm",
  "localai",
  "openai",
] as const;
export type LocalServerKind = (typeof LOCAL_SERVER_KINDS)[number];
export interface LocalModel {
  id: string;
  /** Bytes on disk, when the server reports it. */
  size: number | null;
  parameters: string | null;
  quantization: string | null;
  family: string | null;
}
/** A local model server found on this host. Only fixed loopback ports and containers are probed. */
export interface LocalModelServer {
  /** `everyos`, `port:<port>` or `container:<id>`; actions name a server by this id, never by URL. */
  id: string;
  kind: LocalServerKind;
  source: "everyos" | "native" | "container";
  name: string;
  /** Address the EveryOS host uses. */
  baseUrl: string;
  version: string | null;
  /** False when the server is installed but did not answer. */
  online: boolean;
  needsKey: boolean;
  models: LocalModel[];
  /** Base URL that EveryOS-managed agent containers can use, if any. */
  containerUrl: string | null;
  containerAccess: "network" | "host-gateway" | "loopback-only" | "unknown";
  /** Ollama servers can pull and delete models. */
  manageable: boolean;
}
export const OLLAMA_ACCELERATIONS = ["cpu", "nvidia", "amd"] as const;
export type OllamaAcceleration = (typeof OLLAMA_ACCELERATIONS)[number];
/**
 * Ollama library models offered for download, smallest first. Sizes are download sizes, verified
 * on 2026-10-15; `memoryGb` is the host memory a CPU-only run comfortably needs.
 */
export const SUGGESTED_LOCAL_MODELS = [
  { id: "qwen3:0.6b", bytes: 520_000_000, memoryGb: 2 },
  { id: "gemma3:1b", bytes: 810_000_000, memoryGb: 2 },
  { id: "llama3.2:3b", bytes: 2_020_000_000, memoryGb: 4 },
  { id: "qwen3:4b", bytes: 2_500_000_000, memoryGb: 6 },
  { id: "gemma3:4b", bytes: 3_350_000_000, memoryGb: 6 },
  { id: "llama3.1:8b", bytes: 4_920_000_000, memoryGb: 10 },
  { id: "qwen3:8b", bytes: 5_230_000_000, memoryGb: 10 },
  { id: "gemma3:12b", bytes: 8_160_000_000, memoryGb: 16 },
  { id: "qwen3:14b", bytes: 9_280_000_000, memoryGb: 16 },
  { id: "gpt-oss:20b", bytes: 13_790_000_000, memoryGb: 24 },
] as const;
export interface EveryosOllamaView {
  app: InstalledAppView | null;
  acceleration: OllamaAcceleration;
  /** GPU runtimes Docker can use on this host. */
  hardware: { nvidia: boolean; amd: boolean };
  /** Host memory, for model suggestions. */
  memoryBytes: number | null;
  /** Why EveryOS cannot install Ollama here, if it cannot. */
  unavailable: "docker" | "compose" | "architecture" | null;
}
export interface LocalModelsView {
  ollama: EveryosOllamaView;
  servers: LocalModelServer[];
  pulls: LocalModelPull[];
}
export interface LocalModelPull {
  id: string;
  serverId: string;
  model: string;
  state: "running" | "succeeded" | "failed" | "cancelled";
  /** The server's last progress status, e.g. "pulling manifest". */
  status: string;
  completed: number;
  total: number;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}
/** Agent-to-API only; snapshots must never be forwarded to the browser. */
export interface NativeAgentSnapshot {
  discovery: AiAgentDiscovery;
  settings: AiAgentSettings;
  gatewayKey: string | null;
  providerKey: string | null;
  conversations: Array<{
    sourceId: string;
    messages: AiChatMessage[];
    updatedAt: number;
    truncated: boolean;
  }>;
}
