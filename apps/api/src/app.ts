import type { ApiErrorBody } from "@otuken/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./context.ts";
import { ApiError, notFound } from "./http/errors.ts";
import { serveWebClient } from "./http/static.ts";
import { loadSession } from "./middleware/auth.ts";
import { csrfProtection } from "./middleware/csrf.ts";
import { requestContext } from "./middleware/request-context.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { accountRoutes } from "./modules/account/routes.ts";
import { auditRoutes } from "./modules/audit/routes.ts";
import { authRoutes } from "./modules/auth/routes.ts";
import { healthRoutes } from "./modules/health/routes.ts";
import { setupRoutes } from "./modules/setup/routes.ts";
import { systemRoutes } from "./modules/system/routes.ts";
import { userRoutes } from "./modules/users/routes.ts";
import type { Services } from "./services.ts";

const MAX_JSON_BODY_BYTES = 64 * 1024;

export function createApp(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", requestContext(services));
  app.use("*", securityHeaders(services));
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_JSON_BODY_BYTES,
      onError: () => {
        throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
      },
    }),
  );
  app.use("/api/*", loadSession(services));
  app.use("/api/*", csrfProtection(services));

  const api = new Hono<AppEnv>();
  api.route("/", healthRoutes(services));
  api.route("/", setupRoutes(services));
  api.route("/auth", authRoutes(services));
  api.route("/account", accountRoutes(services));
  api.route("/users", userRoutes(services));
  api.route("/audit", auditRoutes(services));
  api.route("/system", systemRoutes(services));
  api.all("*", () => {
    throw notFound("Endpoint");
  });
  app.route("/api", api);

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
