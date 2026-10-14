import { AI_AGENT_KINDS } from "@everyos/shared";
import {
  AiAgentKindSchema,
  AiAgentSettingsSchema,
  AiChatRequestSchema,
  NativeAgentIdSchema,
} from "@everyos/shared/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { agentActor } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { openEventStream } from "../../http/event-stream.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const Empty = z.strictObject({});
const Kind = z.strictObject({ kind: AiAgentKindSchema });
const Conversation = z.strictObject({ kind: AiAgentKindSchema, id: z.string().uuid() });
const Action = z.strictObject({
  action: z.enum(["install", "start", "stop", "restart", "retry"]),
  confirm: AiAgentKindSchema,
});
export function aiAgentRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requirePermission("apps:manage"), requirePermission("terminal:access"));
  const actor = (c: Parameters<typeof requireAuth>[0]) =>
    agentActor(requireAuth(c), c.get("client").ip);
  app.get("/", async (c) => {
    parseQuery(c, Empty);
    const userId = requireAuth(c).user.id;
    return c.json({
      agents: await Promise.all(
        AI_AGENT_KINDS.map((kind) =>
          services.aiAgents.view(userId, kind, actor(c), c.req.raw.signal),
        ),
      ),
    });
  });
  app.get("/discover", async (c) => {
    parseQuery(c, Empty);
    return c.json(await services.aiAgents.discover(actor(c), c.req.raw.signal));
  });
  app.post("/:kind/import", async (c) => {
    parseQuery(c, Empty);
    const { kind } = parseParams(c, Kind);
    const input = await parseJsonBody(
      c,
      z
        .strictObject({
          id: NativeAgentIdSchema,
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          includeSettings: z.boolean(),
          includeHistory: z.boolean(),
          confirm: AiAgentKindSchema,
        })
        .refine((value) => value.includeSettings || value.includeHistory),
    );
    if (input.confirm !== kind)
      throw new ApiError(422, "VALIDATION_FAILED", "Agent import confirmation required");
    return c.json(
      await services.aiAgents.importNative(
        requireAuth(c).user.id,
        kind,
        input,
        actor(c),
        c.req.raw.signal,
      ),
    );
  });
  app.get("/:kind", async (c) => {
    parseQuery(c, Empty);
    const { kind } = parseParams(c, Kind);
    return c.json(
      await services.aiAgents.view(requireAuth(c).user.id, kind, actor(c), c.req.raw.signal),
    );
  });
  app.put("/:kind", async (c) => {
    parseQuery(c, Empty);
    const { kind } = parseParams(c, Kind);
    const input = await parseJsonBody(c, AiAgentSettingsSchema);
    const job = await services.aiAgents.save(requireAuth(c).user.id, kind, input, actor(c));
    return c.json({ job });
  });
  app.post("/:kind/actions", async (c) => {
    parseQuery(c, Empty);
    const { kind } = parseParams(c, Kind);
    const input = await parseJsonBody(c, Action);
    if (input.confirm !== kind)
      throw new ApiError(422, "VALIDATION_FAILED", "Agent confirmation required");
    const userId = requireAuth(c).user.id;
    try {
      return c.json(
        {
          job:
            input.action === "install"
              ? await services.aiAgents.install(userId, kind, actor(c))
              : await services.aiAgents.control(userId, kind, input.action, actor(c)),
        },
        202,
      );
    } catch (error) {
      const auth = requireAuth(c);
      services.audit.record({
        action: `ai-agent.${input.action}`,
        target: kind,
        outcome: "failure",
        actor: { userId: auth.user.id, username: auth.user.username },
        ip: c.get("client").ip,
        details: { reason: error instanceof ApiError ? error.code : "AGENT_OPERATION_FAILED" },
      });
      throw error;
    }
  });
  app.get("/:kind/conversations", (c) => {
    parseQuery(c, Empty);
    const { kind } = parseParams(c, Kind);
    return c.json({ conversations: services.aiAgents.conversations(requireAuth(c).user.id, kind) });
  });
  app.post("/:kind/conversations", async (c) => {
    parseQuery(c, Empty);
    const { kind } = parseParams(c, Kind);
    await parseJsonBody(c, Empty);
    return c.json(services.aiAgents.createConversation(requireAuth(c).user.id, kind), 201);
  });
  app.get("/:kind/conversations/:id", (c) => {
    parseQuery(c, Empty);
    const { kind, id } = parseParams(c, Conversation);
    return c.json(services.aiAgents.conversation(requireAuth(c).user.id, kind, id));
  });
  app.delete("/:kind/conversations/:id", async (c) => {
    parseQuery(c, Empty);
    const { kind, id } = parseParams(c, Conversation);
    const input = await parseJsonBody(c, z.strictObject({ confirmId: z.string().uuid() }));
    if (input.confirmId !== id)
      throw new ApiError(422, "VALIDATION_FAILED", "Conversation confirmation required");
    services.aiAgents.deleteConversation(requireAuth(c).user.id, kind, id, actor(c));
    return c.body(null, 204);
  });
  app.post("/:kind/chat", async (c) => {
    parseQuery(c, Empty);
    const { kind } = parseParams(c, Kind);
    const input = await parseJsonBody(c, AiChatRequestSchema);
    const run = services.aiAgents.beginChat(
      requireAuth(c).user.id,
      kind,
      input.conversationId,
      input.content,
      actor(c),
    );
    return openEventStream(c, services, {
      permissions: ["apps:manage", "terminal:access"],
      describeError: (error) =>
        error instanceof ApiError
          ? String((error.details as { reason?: string } | undefined)?.reason ?? error.code)
          : "offline",
      async run({ signal, send }) {
        const conversation = await run(signal, (text) => send("delta", { text }));
        if (!signal.aborted) await send("complete", { conversation });
      },
    });
  });
  app.post("/:kind/chat/cancel", async (c) => {
    parseQuery(c, Empty);
    const { kind } = parseParams(c, Kind);
    const { conversationId } = await parseJsonBody(
      c,
      z.strictObject({ conversationId: z.string().uuid() }),
    );
    return c.json(await services.aiAgents.cancelChat(requireAuth(c).user.id, kind, conversationId));
  });
  return app;
}
