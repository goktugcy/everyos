import type { AppJobView, InstalledAppView } from "./catalogs.ts";

export const AI_AGENT_KINDS = ["hermes", "openclaw"] as const;
export const AI_AGENT_CATALOG_ID = "2d17f74b-a6bf-4bc1-a6e0-cece08c09f07";
export type AiAgentKind = (typeof AI_AGENT_KINDS)[number];
export const AI_PROVIDERS = ["openrouter", "openai", "custom"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export interface AiAgentSettings {
  mode: "managed" | "external";
  baseUrl: string;
  apiModel: string;
  provider: AiProvider;
  providerUrl: string;
  model: string;
  maxIterations: number;
  tools: boolean;
}
export interface AiAgentView {
  kind: AiAgentKind;
  configured: boolean;
  settings: AiAgentSettings;
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
  messages: AiChatMessage[];
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
