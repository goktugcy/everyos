import { randomUUID } from "node:crypto";

export class RegistryHttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503;
  constructor(status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503, message: string) {
    super(message);
    this.status = status;
  }
}
export const stmt = (env: Env, sql: string, ...args: (string | number | null)[]) =>
  env.DB.prepare(sql).bind(...args);
export const audit = (env: Env, actor: string, action: string, subject: string) =>
  stmt(
    env,
    "INSERT INTO audit VALUES (?, ?, ?, ?, ?)",
    randomUUID(),
    actor,
    action,
    subject,
    Date.now(),
  );
export const bump = (env: Env) =>
  stmt(
    env,
    "UPDATE registry_state SET revision = revision + 1, updated_at = ? WHERE id = 1",
    Date.now(),
  );

/** D1 batch is transactional; the CHECK aborts every statement if its precondition lost a race. */
export async function atomic(
  env: Env,
  condition: string,
  args: (string | number | null)[],
  writes: D1PreparedStatement[],
): Promise<void> {
  try {
    await env.DB.batch([
      stmt(
        env,
        `INSERT INTO operation_guards VALUES (1, CASE WHEN (${condition}) THEN 1 ELSE 0 END)`,
        ...args,
      ),
      ...writes,
      stmt(env, "DELETE FROM operation_guards WHERE id = 1"),
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      /CHECK constraint failed|UNIQUE constraint failed/.test(error.message)
    )
      throw new RegistryHttpError(409, "state-conflict");
    throw error;
  }
}
export async function boundedBody(request: Request, limit: number): Promise<Buffer> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new RegistryHttpError(413, "body-too-large");
  if (!request.body) return Buffer.alloc(0);
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RegistryHttpError(413, "body-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
export async function rateLimit(env: Env, identity: string, max: number, windowMs = 3600000) {
  const window = Math.floor(Date.now() / windowMs);
  const row = await stmt(
    env,
    "INSERT INTO rate_limits VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET hits = hits + 1 RETURNING hits",
    `${identity}:${window}`,
    (window + 1) * windowMs,
  ).first<{ hits: number }>();
  if (!row || row.hits > max) throw new RegistryHttpError(429, "rate-limit");
}
export interface Publisher {
  id: string;
  name: string;
  keys_json: string;
}
export interface Artifact {
  publisher_id: string;
  hash: string;
  kind: "package" | "image";
  size: number;
  mime: string;
  manifest_json: string | null;
  signature: string | null;
}
export interface Submission {
  id: string;
  publisher_id: string;
  app_id: string;
  version: string;
  package_hash: string;
  icon_hash: string;
  screenshots_json: string;
  changelog: string;
  status: "pending" | "approved" | "rejected";
  created_at: number;
}
export async function artifact(env: Env, owner: string, hash: string, kind: Artifact["kind"]) {
  const found = await stmt(
    env,
    "SELECT * FROM artifacts WHERE publisher_id = ? AND hash = ? AND kind = ?",
    owner,
    hash,
    kind,
  ).first<Artifact>();
  if (!found) throw new RegistryHttpError(422, "artifact-not-owned");
  return found;
}
export const artifactKey = (kind: Artifact["kind"], hash: string) =>
  `${kind === "package" ? "packages" : "images"}/${hash}`;
