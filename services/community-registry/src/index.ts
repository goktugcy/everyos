import { createHmac, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { PackageError } from "@everyos/app-package";
import { CommunityHash } from "@everyos/app-registry";
import { publicArtifact, registryIdentity } from "./publication.ts";
import { artifactKey, rateLimit, RegistryHttpError, stmt } from "./storage.ts";
import { fail, logger, type Bindings } from "./http.ts";
import identity from "./identity.ts";
import intake from "./intake.ts";
import moderation from "./moderation.ts";
import { scheduled } from "./maintenance.ts";
const app = new Hono<Bindings>();
app.use("*", async (c, next) => {
  if (
    c.env.ADMIN_TOKEN.length < 32 ||
    !c.env.REGISTRY_PRIVATE_KEY ||
    (String(c.env.ENVIRONMENT) !== "local" && new URL(c.env.PUBLIC_ORIGIN).protocol !== "https:")
  )
    fail(503, "unconfigured");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  // No permissive CORS: bearer credentials are used by the CLI, never cookies.
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const peer = c.req.header("cf-connecting-ip") ?? "local";
    const identity = createHmac("sha256", c.env.ADMIN_TOKEN).update(peer).digest("hex");
    await rateLimit(c.env, `request:${identity}`, 180);
  }
  if (c.req.path !== "/v1/artifacts/package") z.strictObject({}).parse(c.req.query());
  await next();
});
app.onError((error, c) => {
  if (error instanceof RegistryHttpError) return c.json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return c.json({ error: "invalid-input" }, 400);
  if (error instanceof PackageError)
    return c.json({ error: "invalid-package", code: error.code }, 422);
  logger.error("registry.request.failed", { requestId: randomUUID() });
  return c.json({ error: "internal-error" }, 500);
});
app.notFound((c) => c.json({ error: "not-found" }, 404));
app.get("/health", (c) => c.json({ status: "ok", environment: c.env.ENVIRONMENT }));
app.get("/.well-known/everyos-registry", (c) =>
  c.json({
    ...registryIdentity(c.env),
    indexUrl: `${c.env.PUBLIC_ORIGIN}/index.json`,
    environment: c.env.ENVIRONMENT,
  }),
);
app.get("/registry.pub", (c) => c.text(registryIdentity(c.env).publicKey));
app.get("/index.json", async (c) => {
  const state = await stmt(
    c.env,
    "SELECT object_key, expires_at FROM registry_state WHERE id = 1",
  ).first<{ object_key: string | null; expires_at: number }>();
  if (!state?.object_key || state.expires_at <= Date.now()) fail(503, "catalog-not-published");
  const object = await c.env.ARTIFACTS.get(state.object_key);
  if (!object) fail(503, "catalog-unavailable");
  return new Response(object.body, {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
for (const kind of ["package", "image"] as const) {
  app.get(`/${kind === "package" ? "packages" : "images"}/:hash`, async (c) => {
    const digest = CommunityHash.parse(c.req.param("hash"));
    if (!(await publicArtifact(c.env, kind, digest))) fail(404, "not-found");
    const object = await c.env.ARTIFACTS.get(artifactKey(kind, digest));
    if (!object) fail(404, "not-found");
    return new Response(object.body, {
      headers: {
        "content-type":
          kind === "package"
            ? "application/octet-stream"
            : (object.httpMetadata?.contentType ?? "application/octet-stream"),
        "content-disposition": `attachment; filename="${digest}.${kind === "package" ? "eosapp" : "image"}"`,
        "content-length": String(object.size),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
app.route("/", identity);
app.route("/", intake);
app.route("/", moderation);
export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
