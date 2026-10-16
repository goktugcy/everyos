import { z } from "zod";
import {
  AI_AGENT_KINDS,
  AI_PROVIDERS,
  LOCAL_LANGUAGES,
  LOCAL_LENGTHS,
  LOCAL_MEMORY,
  LOCAL_PRESETS,
  OLLAMA_ACCELERATIONS,
} from "../ai-agents.ts";

export const AiAgentKindSchema = z.enum(AI_AGENT_KINDS);
const Url = z
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/.test(value));
const Secret = z
  .string()
  .max(4096)
  .refine((value) => !/[\r\n\0]/.test(value));
export const LocalBehaviorSchema = z.strictObject({
  preset: z.enum(LOCAL_PRESETS),
  instructions: z
    .string()
    .max(4000)
    .refine((value) => !value.includes("\0")),
  language: z.enum(LOCAL_LANGUAGES),
  creativity: z.number().int().min(0).max(100),
  length: z.enum(LOCAL_LENGTHS),
  memory: z.enum(LOCAL_MEMORY),
  repetition: z.number().int().min(0).max(100),
});
export const LocalPreviewRequestSchema = z.strictObject({
  behavior: LocalBehaviorSchema,
  prompt: z.string().trim().min(1).max(2000),
});
const SettingsBase = z.strictObject({
  mode: z.enum(["managed", "external"]),
  baseUrl: Url,
  apiModel: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !/[\r\n\0]/.test(value)),
  provider: z.enum(AI_PROVIDERS),
  providerUrl: Url,
  model: z
    .string()
    .trim()
    .max(200)
    .refine((value) => !/[\r\n\0]/.test(value)),
  maxIterations: z.number().int().min(1).max(100),
  tools: z.boolean(),
  behavior: LocalBehaviorSchema.optional(),
  gatewayKey: Secret.optional(),
  providerKey: Secret.optional(),
  clearProviderKey: z.boolean().optional(),
});
export const AiAgentSettingsSchema = SettingsBase.refine(
  (value) => value.mode !== "managed" || value.model.length > 0,
  {
    path: ["model"],
    message: "A model is required for managed agents",
  },
);
export const AiChatRequestSchema = z.strictObject({
  conversationId: z.string().uuid(),
  content: z.string().trim().min(1).max(16_000),
});
const ListedId = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(value) && value.trim() === value);
/**
 * Provider slugs (Hermes: `openrouter`, `custom`, `custom:<name>`) and model ids exactly as the
 * agent listed them; the API only accepts a pair found in a freshly fetched list.
 */
export const AiModelRefSchema = z.strictObject({
  provider: ListedId(120).nullable(),
  model: ListedId(200),
});
export const AiChatModelRequestSchema = z.strictObject({
  /** null returns to the agent's own default (Hermes). */
  model: AiModelRefSchema.nullable(),
  /** Required when the switch restarts the agent (managed OpenClaw). */
  restart: z.boolean().optional(),
});
export const AiConversationUpdateSchema = z
  .strictObject({ favorite: z.boolean().optional(), archived: z.boolean().optional() })
  .refine((value) => value.favorite !== undefined || value.archived !== undefined);

/** Ollama-style model names: `[host/][namespace/]name[:tag]`, e.g. `qwen2.5:3b`. */
export const LocalModelNameSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][\w.-]*(?:\/[A-Za-z0-9][\w.-]*){0,3}(?::[A-Za-z0-9][\w.-]{0,127})?$/);
export const LocalServerIdSchema = z
  .string()
  .regex(/^(?:everyos|port:[1-9]\d{0,4}|container:[a-f0-9]{12,64})$/);
export const LocalModelPullRequestSchema = z.strictObject({
  model: LocalModelNameSchema,
  /** Required for a server EveryOS did not install. */
  confirmExternal: z.boolean().optional(),
});
export const LocalModelDeleteRequestSchema = z.strictObject({
  model: LocalModelNameSchema,
  /** Must repeat the model name. */
  confirm: z.string().max(200),
  confirmExternal: z.boolean().optional(),
});
export const OllamaSetupRequestSchema = z.strictObject({
  acceleration: z.enum(OLLAMA_ACCELERATIONS),
  confirm: z.literal("ollama"),
});

export const NativeAgentIdSchema = z
  .string()
  .regex(/^(hermes|openclaw|clawdbot)(?::[A-Za-z0-9_-]{1,64})?$/);
export const AiDiscoverySchema = z.strictObject({
  id: z.string().max(200),
  kind: AiAgentKindSchema,
  source: z.enum(["native", "container"]),
  name: z.string().max(200),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  baseUrl: Url,
  apiModel: z.string().max(200),
  canImport: z.boolean(),
  hasGatewayKey: z.boolean(),
  hasProviderKey: z.boolean(),
  historyCount: z.number().int().min(0).max(20),
  historyWarning: z.enum(["limited", "unreadable", "unsupported"]).nullable(),
});
export const NativeAgentSnapshotSchema = z.strictObject({
  discovery: AiDiscoverySchema,
  settings: SettingsBase.omit({
    gatewayKey: true,
    providerKey: true,
    clearProviderKey: true,
  }),
  gatewayKey: Secret.nullable(),
  providerKey: Secret.nullable(),
  conversations: z
    .array(
      z.strictObject({
        sourceId: z.string().max(300),
        messages: z
          .array(
            z.strictObject({
              role: z.enum(["user", "assistant"]),
              content: z.string().max(128 * 1024),
            }),
          )
          .max(40),
        updatedAt: z.number().int().min(0),
        truncated: z.boolean(),
      }),
    )
    .max(20),
});
