import type { ApiErrorBody } from "@everyos/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./context.ts";
import { ApiError, notFound } from "./http/errors.ts";
import { serveWebClient } from "./http/static.ts";
import { enforceTwoFactor, enforceUnlocked, loadSession } from "./middleware/auth.ts";
import { csrfProtection } from "./middleware/csrf.ts";
import { requestContext } from "./middleware/request-context.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { accountRoutes } from "./modules/account/routes.ts";
import { auditRoutes } from "./modules/audit/routes.ts";
import { authRoutes } from "./modules/auth/routes.ts";
import { dockerRoutes } from "./modules/docker/routes.ts";
import { catalogRoutes } from "./modules/catalogs/routes.ts";
import { appRoutes } from "./modules/apps/routes.ts";
import { aiAgentRoutes } from "./modules/ai-agents/routes.ts";
import { eventRoutes } from "./modules/events/routes.ts";
import { healthRoutes } from "./modules/health/routes.ts";
import { selfUpdateRoutes } from "./modules/self-update/routes.ts";
import { existsSync } from "node:fs";
import { integrationRoutes } from "./modules/integrations/routes.ts";
import { logRoutes } from "./modules/logs/routes.ts";
import { notificationChannelRoutes } from "./modules/notifications/channel-routes.ts";
import { transferRoutes } from "./modules/transfers/routes.ts";
import { driveRoutes } from "./modules/drive/routes.ts";
import { notificationRoutes } from "./modules/notifications/routes.ts";
import { fileRoutes } from "./modules/files/routes.ts";
import { terminalRoutes } from "./modules/terminal/routes.ts";
import { updateRoutes } from "./modules/updates/routes.ts";
import { taskRoutes } from "./modules/tasks/routes.ts";
import { preferenceRoutes } from "./modules/preferences/routes.ts";
import { serviceRoutes } from "./modules/services/routes.ts";
import { setupRoutes } from "./modules/setup/routes.ts";
import { systemRoutes } from "./modules/system/routes.ts";
import { httpsRoutes } from "./modules/security/https-routes.ts";
import { securityRoutes } from "./modules/security/routes.ts";
import { userRoutes } from "./modules/users/routes.ts";
import { desktopAppRoutes } from "./modules/desktop-apps/routes.ts";
import { appSdkRoutes } from "./modules/desktop-apps/sdk-routes.ts";
import { appRuntimeRoutes } from "./modules/desktop-apps/runtime-routes.ts";
import { backupRoutes } from "./modules/backups/routes.ts";
import { wallpaperRoutes } from "./modules/wallpapers/routes.ts";
import type { Services } from "./services.ts";

const MAX_JSON_BODY_BYTES = 64 * 1024;

export function createApp(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", requestContext(services));
  app.use("*", securityHeaders(services));
  const jsonBodyLimit = bodyLimit({
    maxSize: MAX_JSON_BODY_BYTES,
    onError: () => {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
    },
  });
  // The text editor saves up to 1 MiB of text (JSON-escaped).
  const textBodyLimit = bodyLimit({
    maxSize: 4 * 1024 * 1024,
    onError: () => {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
    },
  });
  // Wallpaper, file and backup uploads stream to disk with their own (larger) limits.
  const enforceBodyLimit: MiddlewareHandler<AppEnv> = (c, next) => {
    if (
      c.req.method === "POST" &&
      (c.req.path === "/api/wallpapers" ||
        c.req.path === "/api/folder-icons" ||
        c.req.path === "/api/files/upload" ||
        c.req.path === "/api/drive/upload" ||
        c.req.path === "/api/backups/upload")
    )
      return next();
    if (c.req.method === "PUT" && c.req.path === "/api/files/text") return textBodyLimit(c, next);
    // App storage values reach 256 KiB of JSON.
    if (c.req.method === "POST" && c.req.path === "/api/app-sdk/storage/set")
      return textBodyLimit(c, next);
    return jsonBodyLimit(c, next);
  };
  app.use("/api/*", enforceBodyLimit);
  app.use("/api/*", loadSession(services));
  app.use("/api/*", csrfProtection(services));
  app.use("/api/*", enforceUnlocked);
  app.use("/api/*", enforceTwoFactor(services));

  const api = new Hono<AppEnv>();
  api.use("*", async (c, next) => {
    if (
      services.config.mode === "production" &&
      existsSync("/run/everyos-update-maintenance") &&
      !["/api/health", "/api/self-update", "/api/bootstrap"].includes(c.req.path)
    )
      throw new ApiError(503, "INTERNAL_ERROR", "EveryOS update maintenance is in progress");
    await next();
  });
  api.route("/self-update", selfUpdateRoutes(services));
  api.route("/", healthRoutes(services));
  api.route("/", setupRoutes(services));
  api.route("/auth", authRoutes(services));
  api.route("/account", accountRoutes(services));
  api.route("/users", userRoutes(services));
  api.route("/security", securityRoutes(services));
  api.route("/https", httpsRoutes(services));
  api.route("/audit", auditRoutes(services));
  api.route("/system", systemRoutes(services));
  api.route("/services", serviceRoutes(services));
  api.route("/logs", logRoutes(services));
  api.route("/docker", dockerRoutes(services));
  api.route("/integrations", integrationRoutes(services));
  api.route("/notification-channels", notificationChannelRoutes(services));
  api.route("/transfers", transferRoutes(services));
  api.route("/drive", driveRoutes(services));
  api.route("/notifications", notificationRoutes(services));
  api.route("/files", fileRoutes(services));
  api.route("/terminal", terminalRoutes(services));
  api.route("/updates", updateRoutes(services));
  api.route("/tasks", taskRoutes(services));
  api.route("/backups", backupRoutes(services));
  api.route("/catalogs", catalogRoutes(services));
  api.route("/apps", appRoutes(services));
  api.route("/desktop-apps", desktopAppRoutes(services));
  api.route("/app-sdk", appSdkRoutes(services));
  api.route("/ai-agents", aiAgentRoutes(services));
  api.route("/events", eventRoutes(services));
  api.route("/preferences", preferenceRoutes(services));
  api.route("/wallpapers", wallpaperRoutes(services));
  api.route("/folder-icons", wallpaperRoutes(services, "folder-icon"));
  api.all("*", () => {
    throw notFound("Endpoint");
  });
  app.route("/api", api);
  app.route("/app-runtime", appRuntimeRoutes(services.desktopApps.installer));

  if (services.config.paths.webDir) app.use("*", serveWebClient(services.config.paths.webDir));

  app.notFound((c) => c.text("Not Found", 404));

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      };
      for (const [name, value] of Object.entries(error.headers)) c.header(name, value);
      return c.json(body, error.status);
    }
    if (error instanceof HTTPException) {
      const status = error.status;
      const code =
        status === 413 ? "PAYLOAD_TOO_LARGE" : status < 500 ? "BAD_REQUEST" : "INTERNAL_ERROR";
      const body: ApiErrorBody = { error: { code, message: error.message || code } };
      return c.json(body, status);
    }
    (c.get("logger") ?? services.logger).error("Unhandled error", { error });
    const body: ApiErrorBody = {
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    };
    return c.json(body, 500);
  });

  return app;
}
