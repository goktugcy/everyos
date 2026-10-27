import { createHmac, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { appBelongsTo } from "@everyos/app-manifest";
import {
  CommunityId,
  CommunityHash,
  CommunityReview,
  CommunityRevocation,
  CommunityReport,
} from "@everyos/app-registry";
import { admin, developer, fail, json, publication, type Bindings, type Ctx } from "./http.ts";
import { artifactKey, atomic, audit, bump, rateLimit, stmt, type Submission } from "./storage.ts";
const app = new Hono<Bindings>();
app.get("/admin/submissions", async (c) => {
  admin(c);
  return c.json({
    submissions: (
      await stmt(
        c.env,
        `SELECT s.*, a.manifest_json FROM submissions s
    JOIN artifacts a ON a.hash = s.package_hash AND a.publisher_id = s.publisher_id
    WHERE s.status = 'pending' ORDER BY s.created_at LIMIT 100`,
      ).all()
    ).results,
  });
});
app.get("/admin/submissions/:id/:kind/:hash", async (c) => {
  admin(c);
  const id = CommunityId.parse(c.req.param("id")),
    kind = z.enum(["package", "image"]).parse(c.req.param("kind")),
    digest = CommunityHash.parse(c.req.param("hash"));
  const submission = await stmt(
    c.env,
    "SELECT * FROM submissions WHERE id = ?",
    id,
  ).first<Submission>();
  if (!submission) fail(404, "not-found");
  const screenshots = z.array(CommunityHash).parse(JSON.parse(submission.screenshots_json));
  if (
    !(kind === "package"
      ? submission.package_hash === digest
      : submission.icon_hash === digest || screenshots.includes(digest))
  )
    fail(404, "not-found");
  const object = await c.env.ARTIFACTS.get(artifactKey(kind, digest));
  if (!object) fail(404, "not-found");
  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${digest}.${kind === "package" ? "eosapp" : "image"}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
});
app.post("/admin/submissions/:id/review", async (c) => {
  admin(c);
  const id = CommunityId.parse(c.req.param("id")),
    input = await json(c, CommunityReview);
  const submission = await stmt(
    c.env,
    "SELECT * FROM submissions WHERE id = ?",
    id,
  ).first<Submission>();
  if (!submission) fail(404, "not-found");
  const approved = input.decision === "approved";
  await atomic(
    c.env,
    `EXISTS (SELECT 1 FROM submissions s JOIN publishers p ON p.id = s.publisher_id WHERE s.id = ? AND s.status = 'pending' AND p.active = 1)
    AND NOT EXISTS (SELECT 1 FROM versions WHERE app_id = ? AND version = ?)
    AND (? = 0 OR ((SELECT COUNT(*) FROM versions WHERE app_id = ?) < 50
    AND (SELECT COUNT(*) FROM versions) < 200))`,
    [id, submission.app_id, submission.version, Number(approved), submission.app_id],
    [
      stmt(
        c.env,
        "INSERT INTO reviews VALUES (?, ?, ?, ?)",
        id,
        input.decision,
        input.note,
        Date.now(),
      ),
      stmt(c.env, "UPDATE submissions SET status = ? WHERE id = ?", input.decision, id),
      ...(approved
        ? [
            stmt(
              c.env,
              "INSERT INTO versions VALUES (?, ?, ?, ?)",
              submission.app_id,
              submission.version,
              id,
              Date.now(),
            ),
            bump(c.env),
          ]
        : []),
      audit(c.env, "admin", `submission.${input.decision}`, id),
    ],
  );
  return approved ? publication(c) : c.json({ status: "rejected" });
});
app.post("/v1/revocations", async (c) => {
  const publisher = await developer(c),
    input = await json(c, CommunityRevocation);
  if (!appBelongsTo(input.appId, publisher.id)) fail(403, "namespace-mismatch");
  await revoke(c, input, publisher.id);
  return publication(c);
});
async function revoke(c: Ctx, input: z.infer<typeof CommunityRevocation>, actor: string) {
  await atomic(
    c.env,
    "EXISTS (SELECT 1 FROM versions WHERE app_id = ? AND (? = '*' OR version = ?))",
    [input.appId, input.version, input.version],
    [
      stmt(
        c.env,
        "INSERT INTO revocations VALUES (?, ?, ?) ON CONFLICT(app_id, version) DO UPDATE SET reason = excluded.reason",
        input.appId,
        input.version,
        input.reason,
      ),
      audit(c.env, actor, "version.revoked", `${input.appId}@${input.version}`),
      bump(c.env),
    ],
  );
}
app.post("/admin/revocations", async (c) => {
  admin(c);
  const input = await json(c, CommunityRevocation);
  await revoke(c, input, "admin");
  return publication(c);
});
app.post("/admin/publish", async (c) => {
  admin(c);
  await json(c, z.strictObject({}));
  await c.env.DB.batch([bump(c.env), audit(c.env, "admin", "catalog.refreshed", "community")]);
  return publication(c);
});
app.post("/v1/reports", async (c) => {
  const input = await json(c, CommunityReport);
  const peer = c.req.header("cf-connecting-ip") ?? "local";
  await rateLimit(
    c.env,
    `report:${createHmac("sha256", c.env.ADMIN_TOKEN).update(peer).digest("hex")}`,
    5,
    86400000,
  );
  const id = randomUUID();
  await atomic(
    c.env,
    "(SELECT COUNT(*) FROM reports WHERE resolved_at IS NULL) < 10000",
    [],
    [
      stmt(
        c.env,
        "INSERT INTO reports VALUES (?, ?, ?, ?, ?, NULL, NULL)",
        id,
        input.appId,
        input.version ?? null,
        input.reason,
        Date.now(),
      ),
      audit(c.env, "anonymous", "abuse.reported", id),
    ],
  );
  return c.json({ id, status: "received" }, 201);
});
app.get("/admin/reports", async (c) => {
  admin(c);
  return c.json({
    reports: (
      await stmt(
        c.env,
        "SELECT * FROM reports WHERE resolved_at IS NULL ORDER BY created_at LIMIT 100",
      ).all()
    ).results,
  });
});
app.post("/admin/reports/:id/resolve", async (c) => {
  admin(c);
  const id = CommunityId.parse(c.req.param("id")),
    input = await json(c, z.strictObject({ resolution: z.string().trim().min(1).max(2000) }));
  await atomic(
    c.env,
    "EXISTS (SELECT 1 FROM reports WHERE id = ? AND resolved_at IS NULL)",
    [id],
    [
      stmt(
        c.env,
        "UPDATE reports SET resolution = ?, resolved_at = ? WHERE id = ?",
        input.resolution,
        Date.now(),
        id,
      ),
      audit(c.env, "admin", "abuse.resolved", id),
    ],
  );
  return c.json({ status: "resolved" });
});

export default app;
