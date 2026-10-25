import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { z } from "zod";
import { CommunityPublicKey } from "@everyos/app-registry";
import { createLogger } from "@everyos/logger";
import { publishIndex } from "./publication.ts";
import { boundedBody, RegistryHttpError, type Publisher } from "./storage.ts";

export type Bindings = { Bindings: Env };
export type Ctx = Context<Bindings>;
export const logger = createLogger({ name: "community-registry", format: "json" });
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export function fail(
  status: ConstructorParameters<typeof RegistryHttpError>[0],
  message: string,
): never {
  throw new RegistryHttpError(status, message);
}
export const bearer = (c: Ctx) =>
  /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
export const keysOf = (publisher: Publisher) =>
  z.array(CommunityPublicKey).max(4).parse(JSON.parse(publisher.keys_json));
export async function json<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  if (!(c.req.header("content-type") ?? "").startsWith("application/json"))
    fail(400, "json-required");
  try {
    return schema.parse(JSON.parse((await boundedBody(c.req.raw, 16 * 1024)).toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) fail(400, "invalid-json");
    throw error;
  }
}
export function admin(c: Ctx) {
  const value = bearer(c);
  if (!value || !timingSafeEqual(Buffer.from(hash(value)), Buffer.from(hash(c.env.ADMIN_TOKEN))))
    fail(401, "unauthorized");
}
export async function developer(c: Ctx): Promise<Publisher> {
  const value = bearer(c);
  if (!value) fail(401, "unauthorized");
  const publisher = await c.env.DB.withSession("first-primary")
    .prepare(
      `SELECT p.id, p.name, p.keys_json FROM tokens t JOIN publishers p ON p.id = t.publisher_id
     WHERE t.hash = ? AND t.revoked = 0 AND t.expires_at > ? AND p.active = 1`,
    )
    .bind(hash(value), Date.now())
    .first<Publisher>();
  if (!publisher) fail(401, "unauthorized");
  return publisher;
}
export async function publication(c: Ctx) {
  try {
    return c.json({ publication: "published", sequence: await publishIndex(c.env) });
  } catch (error) {
    logger.error("registry.publication.pending", {
      kind: error instanceof Error ? error.name : "unknown",
    });
    return c.json({ publication: "pending" }, 202);
  }
}
