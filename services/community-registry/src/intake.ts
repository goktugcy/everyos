import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { appBelongsTo } from "@everyos/app-manifest";
import { parseManifest } from "@everyos/app-manifest/schema";
import { sha256Hex, verifyPackage } from "@everyos/app-package";
import { CommunityAppId, CommunityVersion, CommunitySubmission } from "@everyos/app-registry";
import { developer, fail, json, keysOf, type Bindings } from "./http.ts";
import { artifact, artifactKey, atomic, audit, boundedBody, rateLimit, stmt } from "./storage.ts";
import { COMMUNITY_LIMITS, imageMime, inspectCommunityPackage } from "./validation.ts";
const app = new Hono<Bindings>();
app.post("/v1/artifacts/package", async (c) => {
  const publisher = await developer(c);
  await rateLimit(c.env, `upload:${publisher.id}`, 20);
  const input = z
    .strictObject({
      appId: CommunityAppId,
      version: CommunityVersion,
      signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    })
    .parse(c.req.query());
  if (!appBelongsTo(input.appId, publisher.id)) fail(403, "namespace-mismatch");
  const bytes = await boundedBody(c.req.raw, COMMUNITY_LIMITS.packedBytes);
  if (!bytes.length) fail(422, "empty-package");
  const digest = {
    appId: input.appId,
    version: input.version,
    sha256: sha256Hex(bytes),
    size: bytes.length,
  };
  if (!keysOf(publisher).some((key) => verifyPackage(digest, input.signature, key)))
    fail(403, "invalid-package-signature");
  const manifest = await inspectCommunityPackage(bytes);
  if (
    manifest.id !== input.appId ||
    manifest.version !== input.version ||
    manifest.publisher.id !== publisher.id
  )
    fail(422, "manifest-mismatch");

  await atomic(
    c.env,
    "(SELECT COUNT(*) FROM artifacts WHERE publisher_id = ?) < 300 OR EXISTS (SELECT 1 FROM artifacts WHERE publisher_id = ? AND hash = ?)",
    [publisher.id, publisher.id, digest.sha256],
    [
      stmt(
        c.env,
        "INSERT INTO artifacts VALUES (?, ?, 'package', ?, 'application/octet-stream', ?, ?, ?) ON CONFLICT DO NOTHING",
        publisher.id,
        digest.sha256,
        bytes.length,
        JSON.stringify(manifest),
        input.signature,
        Date.now(),
      ),
      audit(c.env, publisher.id, "package.validated", digest.sha256),
    ],
  );
  await c.env.ARTIFACTS.put(artifactKey("package", digest.sha256), bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: digest.sha256,
  });
  await audit(c.env, publisher.id, "package.uploaded", digest.sha256).run();
  return c.json(
    {
      hash: digest.sha256,
      manifest,
      checks: ["archive", "manifest", "publisher-signature", "html-policy", "locales"],
      reviewRequired: true,
    },
    201,
  );
});
app.post("/v1/artifacts/image", async (c) => {
  const publisher = await developer(c);
  await rateLimit(c.env, `image:${publisher.id}`, 60);
  const bytes = await boundedBody(c.req.raw, 2 * 1024 * 1024),
    mime = imageMime(bytes),
    digest = sha256Hex(bytes);

  await atomic(
    c.env,
    "(SELECT COUNT(*) FROM artifacts WHERE publisher_id = ?) < 300 OR EXISTS (SELECT 1 FROM artifacts WHERE publisher_id = ? AND hash = ?)",
    [publisher.id, publisher.id, digest],
    [
      stmt(
        c.env,
        "INSERT INTO artifacts VALUES (?, ?, 'image', ?, ?, NULL, NULL, ?) ON CONFLICT DO NOTHING",
        publisher.id,
        digest,
        bytes.length,
        mime,
        Date.now(),
      ),
      audit(c.env, publisher.id, "image.validated", digest),
    ],
  );
  await c.env.ARTIFACTS.put(artifactKey("image", digest), bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: digest,
    httpMetadata: { contentType: mime },
  });
  await audit(c.env, publisher.id, "image.uploaded", digest).run();
  return c.json({ hash: digest }, 201);
});
app.post("/v1/submissions", async (c) => {
  const publisher = await developer(c),
    input = await json(c, CommunitySubmission);
  const pkg = await artifact(c.env, publisher.id, input.package, "package");
  const icon = await artifact(c.env, publisher.id, input.icon, "image");
  if (icon.size > 512 * 1024) fail(422, "icon-too-large");
  for (const screenshot of input.screenshots)
    await artifact(c.env, publisher.id, screenshot, "image");
  for (const [kind, hash] of [
    ["package", input.package],
    ["image", input.icon],
    ...input.screenshots.map((hash) => ["image", hash] as const),
  ] as const) {
    if (!(await c.env.ARTIFACTS.head(artifactKey(kind, hash)))) fail(409, "artifact-not-ready");
  }
  const manifest = parseManifest(JSON.parse(pkg.manifest_json!)),
    id = randomUUID();
  await atomic(
    c.env,
    `NOT EXISTS (SELECT 1 FROM versions WHERE app_id = ? AND version = ?)
    AND NOT EXISTS (SELECT 1 FROM submissions WHERE app_id = ? AND version = ? AND status = 'pending')
    AND (SELECT COUNT(*) FROM submissions WHERE publisher_id = ? AND status = 'pending') < 20`,
    [manifest.id, manifest.version, manifest.id, manifest.version, publisher.id],
    [
      stmt(
        c.env,
        "INSERT INTO submissions VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
        id,
        publisher.id,
        manifest.id,
        manifest.version,
        input.package,
        input.icon,
        JSON.stringify(input.screenshots),
        input.changelog,
        Date.now(),
      ),
      audit(c.env, publisher.id, "submission.created", id),
    ],
  );
  return c.json({ id, status: "pending" }, 201);
});
app.get("/v1/submissions", async (c) => {
  const publisher = await developer(c);
  const rows = await stmt(
    c.env,
    `SELECT s.*, r.note AS review_note FROM submissions s LEFT JOIN reviews r ON r.submission_id = s.id
    WHERE s.publisher_id = ? ORDER BY s.created_at DESC LIMIT 100`,
    publisher.id,
  ).all();
  return c.json({ submissions: rows.results });
});

export default app;
