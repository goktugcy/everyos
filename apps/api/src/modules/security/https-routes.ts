import { hostname } from "node:os";
import { TAILSCALE_SERVE_REFUSALS } from "@everyos/shared";
import { LanHttpsRequestSchema, TailscaleServeRequestSchema } from "@everyos/shared/schemas";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../../context.ts";
import { callAgent } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { parseJsonBody } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

/** Reasons Tailscale Serve may refuse, plus the agent not finding or reaching tailscaled. */
const SERVE_REASONS: readonly string[] = [
  ...TAILSCALE_SERVE_REFUSALS,
  "not-detected",
  "socket-missing",
  "permission-denied",
];

/** HTTPS: EveryOS's Tailscale Serve handler and the local-network listener (administrators). */
export function httpsRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const manage = requirePermission("system:manage");
  const { https } = services;

  const audit = (c: Context<AppEnv>, action: string, details: Record<string, unknown>) => {
    const auth = requireAuth(c);
    services.audit.record({
      action: `https.${action}`,
      outcome: "success",
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      details,
    });
  };

  app.get("/", manage, (c) => c.json(https.view()));

  app.put("/tailscale", manage, async (c) => {
    const { enabled } = await parseJsonBody(c, TailscaleServeRequestSchema);
    // Serve forwards to 127.0.0.1, which an API bound to one other address does not answer.
    if (
      enabled &&
      !["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"].includes(services.config.server.host)
    )
      throw new ApiError(409, "CONFLICT", "EveryOS does not listen on loopback", {
        details: { reason: "api-not-on-loopback" },
      });
    let url: string | null;
    try {
      ({ url } = await callAgent(c, services, "tailscale.serve", {
        enabled,
        port: services.config.server.port,
      }));
    } catch (error) {
      const reason =
        error instanceof ApiError && error.code === "CONFLICT"
          ? SERVE_REASONS.find((kind) => error.message.startsWith(`${kind}:`))
          : undefined;
      if (reason)
        throw new ApiError(409, "CONFLICT", "Tailscale Serve was not changed", {
          details: { reason },
        });
      throw error;
    }
    https.recordTailscale(url, requireAuth(c).user.username);
    audit(c, "tailscale", { enabled, url });
    return c.json(https.view());
  });

  app.put("/lan", manage, async (c) => {
    const { enabled, port } = await parseJsonBody(c, LanHttpsRequestSchema);
    if (enabled && port === services.config.server.port)
      throw new ApiError(
        400,
        "VALIDATION_FAILED",
        "The HTTPS port must differ from the HTTP port",
        {
          details: { reason: "same-port" },
        },
      );
    const view = await https.setLan(enabled, port);
    audit(c, "lan", { enabled, port, listening: view.lan.listening });
    return c.json(view);
  });

  /** The certificate authority every device installs once (public; signed-in people only). */
  app.get("/authority.crt", (c) => {
    requireAuth(c);
    const pem = https.authorityPem();
    const host =
      hostname()
        .replace(/[^A-Za-z0-9-]/g, "")
        .slice(0, 32) || "everyos";
    return c.body(pem, 200, {
      "Content-Type": "application/x-x509-ca-cert",
      "Content-Disposition": `attachment; filename="everyos-${host}-ca.crt"`,
      "Cache-Control": "private, no-store",
    });
  });

  return app;
}
