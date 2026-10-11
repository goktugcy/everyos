import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { toApiError } from "../../http/agent.ts";
import { notFound } from "../../http/errors.ts";
import { parseParams } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import type { TerminalViewer } from "./terminal-service.ts";

const SessionParams = z.strictObject({ id: z.string().uuid() });

function viewer(c: Context<AppEnv>): TerminalViewer {
  const auth = requireAuth(c);
  return {
    userId: auth.user.id,
    username: auth.user.username,
    role: auth.user.role,
    sessionId: auth.session.id,
    ip: c.get("client").ip,
  };
}

/** Terminal status and session management; the shell itself uses the WebSocket gateway. */
export function terminalRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requirePermission("terminal:access"));

  app.get("/status", async (c) => {
    try {
      return c.json(await services.terminals.status(viewer(c)));
    } catch (error) {
      throw toApiError(error);
    }
  });

  /** Own sessions; user managers see everyone's. */
  app.get("/sessions", (c) => {
    const auth = requireAuth(c);
    return c.json({
      sessions: services.terminals.sessions(
        auth.permissions.has("users:manage") ? undefined : auth.user.id,
      ),
    });
  });

  app.delete("/sessions/:id", (c) => {
    const { id } = parseParams(c, SessionParams);
    const auth = requireAuth(c);
    const session = services.terminals.sessions().find((s) => s.id === id);
    if (!session || (session.userId !== auth.user.id && !auth.permissions.has("users:manage")))
      throw notFound("Terminal session");
    services.terminals.terminate(id, "closed", viewer(c));
    return c.body(null, 204);
  });

  return app;
}
