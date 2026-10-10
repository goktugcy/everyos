import { ROLES } from "@otuken/shared";
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/**
 * Who asked for an operation. User actors carry the identity the API
 * authenticated; the agent re-derives permissions from the role and records
 * the identity in its own audit log. `system` actors are internal API
 * background jobs (for example metric collection) and may only call
 * operations that explicitly allow them.
 */
export const ActorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user"),
    userId: z.string().min(1).max(64),
    username: z.string().min(1).max(64),
    role: z.enum(ROLES),
    sessionId: z.string().max(64).optional(),
    ip: z.string().max(64).optional(),
  }),
  z.strictObject({
    kind: z.literal("system"),
    component: z.string().min(1).max(32),
  }),
]);

export type Actor = z.infer<typeof ActorSchema>;

const NonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const MacSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const AGENT_ERROR_CODES = [
  "invalid_request",
  "unknown_operation",
  "invalid_params",
  "forbidden",
  "policy_denied",
  "busy",
  "timeout",
  "cancelled",
  "failed",
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/* Agent → API */

export const HelloMessageSchema = z.strictObject({
  type: z.literal("hello"),
  protocol: z.number().int(),
  agentVersion: z.string().max(32),
  nonce: NonceSchema,
});

export const ReadyMessageSchema = z.strictObject({
  type: z.literal("ready"),
  proof: MacSchema,
});

export const ResponseMessageSchema = z.union([
  z.strictObject({
    type: z.literal("response"),
    id: z.number().int().nonnegative(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("response"),
    id: z.number().int().nonnegative(),
    ok: z.literal(false),
    error: z.strictObject({ code: z.enum(AGENT_ERROR_CODES), message: z.string().max(2000) }),
  }),
]);

export const FatalMessageSchema = z.strictObject({
  type: z.literal("fatal"),
  code: z.enum(AGENT_ERROR_CODES),
  message: z.string().max(2000),
});

export const ServerMessageSchema = z.union([
  HelloMessageSchema,
  ReadyMessageSchema,
  ResponseMessageSchema,
  FatalMessageSchema,
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ResponseMessage = z.infer<typeof ResponseMessageSchema>;

/* API → Agent */

export const AuthMessageSchema = z.strictObject({
  type: z.literal("auth"),
  protocol: z.number().int(),
  clientNonce: NonceSchema,
  mac: MacSchema,
});

export const RequestMessageSchema = z.strictObject({
  type: z.literal("request"),
  id: z.number().int().nonnegative(),
  op: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/),
  params: z.unknown(),
  actor: ActorSchema,
});

export const CancelMessageSchema = z.strictObject({
  type: z.literal("cancel"),
  id: z.number().int().nonnegative(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  AuthMessageSchema,
  RequestMessageSchema,
  CancelMessageSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type RequestMessage = z.infer<typeof RequestMessageSchema>;
