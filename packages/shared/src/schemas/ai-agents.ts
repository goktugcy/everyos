import { z } from "zod";
import { AI_AGENT_KINDS, AI_PROVIDERS } from "../ai-agents.ts";

export const AiAgentKindSchema = z.enum(AI_AGENT_KINDS);
const Url = z
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/.test(value));
const Secret = z
  .string()
  .max(4096)
  .refine((value) => !/[\r\n\0]/.test(value));
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
