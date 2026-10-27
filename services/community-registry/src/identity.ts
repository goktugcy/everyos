import { verify } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { keyFingerprint } from "@everyos/app-package";
import {
  CommunityInvitation,
  CommunityEnrollment,
  communityEnrollmentStatement,
} from "@everyos/app-registry";
import {
  admin,
  bearer,
  developer,
  fail,
  hash,
  json,
  keysOf,
  token,
  type Bindings,
} from "./http.ts";
import { atomic, audit, bump, RegistryHttpError, stmt, type Publisher } from "./storage.ts";
const app = new Hono<Bindings>();
app.post("/admin/invitations", async (c) => {
  admin(c);
  const input = await json(c, CommunityInvitation);
  const secret = token(),
    digest = hash(secret),
    expiresAt = Date.now() + 86400000;
  await atomic(
    c.env,
    `NOT EXISTS (SELECT 1 FROM publishers WHERE
    (id = ? AND ? = 0) OR (id != ? AND (instr(id, ? || '.') = 1 OR instr(? , id || '.') = 1)))
    AND (SELECT COUNT(*) FROM publishers) < 500`,
    [
      input.publisherId,
      Number(input.recovery),
      input.publisherId,
      input.publisherId,
      input.publisherId,
    ],
    [
      stmt(
        c.env,
        "INSERT INTO invitations VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
        digest,
        input.publisherId,
        input.name,
        input.email,
        input.reason,
        Number(input.recovery),
        expiresAt,
      ),
      audit(
        c.env,
        "admin",
        input.recovery ? "invitation.recovery.created" : "invitation.created",
        input.publisherId,
      ),
    ],
  );
  return c.json({ invitation: secret, expiresAt }, 201);
});
app.post("/v1/enroll", async (c) => {
  const input = await json(c, CommunityEnrollment);
  try {
    keyFingerprint(input.publicKey);
    if (
      !verify(
        null,
        communityEnrollmentStatement(input),
        input.publicKey,
        Buffer.from(input.proof, "base64"),
      )
    )
      fail(403, "invalid-key-proof");
  } catch (error) {
    if (error instanceof RegistryHttpError) throw error;
    fail(400, "invalid-key");
  }
  const invite = await stmt(
    c.env,
    "SELECT * FROM invitations WHERE hash = ? AND publisher_id = ? AND used_at IS NULL AND expires_at > ?",
    hash(input.invitation),
    input.publisherId,
    Date.now(),
  ).first<{ name: string; email: string; recovery: number }>();
  if (!invite) fail(403, "invalid-invitation");
  const existing = await stmt(
    c.env,
    "SELECT id, name, keys_json FROM publishers WHERE id = ?",
    input.publisherId,
  ).first<Publisher>();
  const keys = [...new Set([...(existing ? keysOf(existing) : []), input.publicKey])];
  if (keys.length > 4) fail(409, "publisher-key-limit");
  const secret = token(),
    expiresAt = Date.now() + 90 * 86400000;
  await atomic(
    c.env,
    `EXISTS (SELECT 1 FROM invitations WHERE hash = ? AND publisher_id = ? AND used_at IS NULL AND expires_at > ?)
    AND NOT EXISTS (SELECT 1 FROM publishers WHERE
      (id = ? AND ? = 0) OR (id != ? AND (instr(id, ? || '.') = 1 OR instr(?, id || '.') = 1)))
    AND NOT EXISTS (SELECT 1 FROM publishers WHERE id = ? AND keys_json != ?)
    AND (EXISTS (SELECT 1 FROM publishers WHERE id = ?) OR (SELECT COUNT(*) FROM publishers) < 500)`,
    [
      hash(input.invitation),
      input.publisherId,
      Date.now(),
      input.publisherId,
      invite.recovery,
      input.publisherId,
      input.publisherId,
      input.publisherId,
      input.publisherId,
      existing?.keys_json ?? "[]",
      input.publisherId,
    ],
    [
      stmt(
        c.env,
        `INSERT INTO publishers VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(id)
        DO UPDATE SET name = excluded.name, email = excluded.email, keys_json = excluded.keys_json, verified_at = excluded.verified_at`,
        input.publisherId,
        invite.name,
        invite.email,
        JSON.stringify(keys),
        Date.now(),
      ),
      stmt(
        c.env,
        "UPDATE invitations SET used_at = ? WHERE hash = ?",
        Date.now(),
        hash(input.invitation),
      ),
      stmt(c.env, "UPDATE tokens SET revoked = 1 WHERE publisher_id = ?", input.publisherId),
      stmt(
        c.env,
        "INSERT INTO tokens VALUES (?, ?, ?, 0)",
        hash(secret),
        input.publisherId,
        expiresAt,
      ),
      audit(c.env, input.publisherId, "publisher.enrolled", input.publisherId),
      bump(c.env),
    ],
  );
  return c.json(
    {
      token: secret,
      expiresAt,
      publisherId: input.publisherId,
      fingerprint: keyFingerprint(input.publicKey),
    },
    201,
  );
});
app.get("/v1/me", async (c) => {
  const publisher = await developer(c);
  return c.json({
    publisherId: publisher.id,
    name: publisher.name,
    fingerprints: keysOf(publisher).map(keyFingerprint),
  });
});
app.post("/v1/token", async (c) => {
  const publisher = await developer(c);
  await json(c, z.strictObject({}));
  const secret = token(),
    expiresAt = Date.now() + 90 * 86400000;
  await atomic(
    c.env,
    "EXISTS (SELECT 1 FROM tokens WHERE hash = ? AND revoked = 0 AND expires_at > ?)",
    [hash(bearer(c)), Date.now()],
    [
      stmt(c.env, "UPDATE tokens SET revoked = 1 WHERE publisher_id = ?", publisher.id),
      stmt(c.env, "INSERT INTO tokens VALUES (?, ?, ?, 0)", hash(secret), publisher.id, expiresAt),
      audit(c.env, publisher.id, "token.rotated", publisher.id),
    ],
  );
  return c.json({ token: secret, expiresAt }, 201);
});

export default app;
