import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  diskRootId,
  type ApiErrorBody,
  type BackupJobView,
  type BackupOverview,
  type BackupView,
  type EncryptedUpload,
  type FileListing,
  type NotificationList,
  type OffsiteView,
  type RestorePreview,
} from "@everyos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptBackup,
  derivePassphraseKey,
  encryptBackup,
  PassphraseError,
  readEncryptedHeader,
  unwrapDataKey,
} from "./modules/backups/encryption.ts";
import { keyIdOf } from "./modules/backups/keyring.ts";
import { applyPendingRestore } from "./modules/backups/snapshot.ts";
import { startFakeGoogle, type FakeGoogle } from "./modules/drive/fake-google.ts";
import { silentLogger } from "@everyos/logger";
import {
  completeSetup,
  createTestContext,
  json,
  STRONG_PASSWORD,
  TestClient,
  type TestContext,
} from "./test-support.ts";

const PASSPHRASE = "dag-basinda-sessiz-bir-ev";
const FAST = { N: 2 ** 14, r: 8, p: 1 };
const MiB = 1024 * 1024;
const USB = "2f6a3c1e-8b4d-4e7a-9f10-3b5c7d9e1a24";

const errorOf = async (response: Response) => (await json<ApiErrorBody>(response)).error;

function from(...chunks: Buffer[]): AsyncIterable<Buffer> {
  return (async function* () {
    await Promise.resolve();
    yield* chunks;
  })();
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function sealed(plain: Buffer) {
  const key = await derivePassphraseKey(PASSPHRASE, undefined, FAST);
  const meta = {
    backupId: "20261018-101500-abcdef",
    createdAt: 1,
    everyosVersion: "0.1.31",
    hostname: "pi",
    includesKey: true,
  };
  const encryption = encryptBackup(key, meta, plain.length);
  // Odd chunk boundaries on the way in.
  const pieces = [plain.subarray(0, 7), plain.subarray(7, 700_001), plain.subarray(700_001)];
  const file = await collect(encryption.encrypt(from(...pieces)));
  return { file, size: encryption.size };
}

async function open(file: Buffer, passphrase = PASSPHRASE) {
  const parsed = readEncryptedHeader(file)!;
  const dataKey = await unwrapDataKey(parsed.header, passphrase);
  return collect(
    decryptBackup(from(file.subarray(parsed.prefix.length)), parsed.header, parsed.prefix, dataKey),
  );
}

describe("encrypted backup format", () => {
  it("round-trips every size around the chunk boundaries and predicts its own size", async () => {
    for (const length of [0, 1, MiB - 1, MiB, MiB + 1, 3 * MiB + 5]) {
      const plain = randomBytes(length);
      const { file, size } = await sealed(plain);
      expect(file.length, String(length)).toBe(size);
      expect(file.subarray(0, 8).toString()).toBe("EOSENC01");
      expect((await open(file)).equals(plain), String(length)).toBe(true);
    }
  });

  it("refuses a wrong passphrase, tampering, truncation and appended bytes", async () => {
    const plain = randomBytes(2 * MiB + 10);
    const { file } = await sealed(plain);
    await expect(open(file, "yanlis-parola-yanlis")).rejects.toBeInstanceOf(PassphraseError);
    const reason = async (bytes: Buffer) =>
      open(bytes).then(
        () => "opened",
        (error: { details?: { reason?: string } }) => error.details?.reason,
      );
    const flipped = Buffer.from(file);
    flipped[file.length - 100]! ^= 1;
    expect(await reason(flipped)).toBe("encrypted-tampered");
    // Dropping the final chunk, or a whole middle one, is detected.
    expect(await reason(file.subarray(0, file.length - (10 + 16)))).toBe("encrypted-length");
    const prefix = readEncryptedHeader(file)!.prefix.length;
    const chunk = MiB + 16;
    const reordered = Buffer.concat([
      file.subarray(0, prefix),
      file.subarray(prefix + chunk, prefix + 2 * chunk),
      file.subarray(prefix, prefix + chunk),
      file.subarray(prefix + 2 * chunk),
    ]);
    expect(await reason(reordered)).toBe("encrypted-tampered");
    expect(await reason(Buffer.concat([file, Buffer.alloc(16)]))).toBe("encrypted-length");
    // The header is authenticated by every chunk.
    const header = Buffer.from(file);
    header.write("qi", file.indexOf('"hostname":"pi"') + 12);
    expect(await reason(header)).toBe("encrypted-tampered");
  });
});

/* ------------------------------------------------------------------- API */

async function backupNow(ctx: TestContext, client: TestClient): Promise<BackupJobView> {
  expect((await client.post("/api/backups", {})).status).toBe(202);
  await vi.waitFor(() => expect(ctx.services.backups.job()).toBeNull(), { timeout: 20_000 });
  return (await json<BackupOverview>(await client.get("/api/backups"))).lastJob!;
}

async function setPassphrase(client: TestClient) {
  const response = await client.request("PUT", "/api/backups/encryption", {
    body: { passphrase: PASSPHRASE, password: STRONG_PASSWORD },
  });
  expect(response.status).toBe(200);
}

async function encryptedDownload(client: TestClient, id: string): Promise<Buffer> {
  const { url } = await json<{ url: string }>(
    await client.post(`/api/backups/${id}/download`, {
      password: STRONG_PASSWORD,
      encrypted: true,
    }),
  );
  const response = await client.get(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toContain(`everyos-backup-${id}.eosbak`);
  const body = Buffer.from(await response.arrayBuffer());
  expect(body.length).toBe(Number(response.headers.get("content-length")));
  return body;
}

describe("passphrase-encrypted backups", () => {
  it("sets the passphrase with the account password and checks it without changing it", async () => {
    const ctx = await createTestContext();
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    expect(await json(await admin.get("/api/backups/encryption"))).toEqual({
      configured: false,
      setAt: null,
      setBy: null,
    });
    const short = await admin.request("PUT", "/api/backups/encryption", {
      body: { passphrase: "kisa", password: STRONG_PASSWORD },
    });
    expect(short.status).toBe(400);
    const badPassword = await admin.request("PUT", "/api/backups/encryption", {
      body: { passphrase: PASSPHRASE, password: "wrong-password-123" },
    });
    expect((await errorOf(badPassword)).code).toBe("AUTH_CURRENT_PASSWORD_INVALID");
    await setPassphrase(admin);
    expect(await json(await admin.get("/api/backups/encryption"))).toMatchObject({
      configured: true,
      setBy: "admin",
    });
    expect(
      await json(await admin.post("/api/backups/encryption/check", { passphrase: PASSPHRASE })),
    ).toEqual({ ok: true });
    expect(
      await json(
        await admin.post("/api/backups/encryption/check", { passphrase: "baska-bir-sey-1" }),
      ),
    ).toEqual({ ok: false });
    // The passphrase is stored sealed, never in the clear.
    const row = ctx.db.get<{ value: string }>(
      "SELECT value FROM instance_settings WHERE key = 'backups.encryption'",
    )!;
    expect(row.value).not.toContain(PASSPHRASE);

    // Removing it needs the password too; then encrypted downloads stop.
    const keep = await admin.request("DELETE", "/api/backups/encryption", {
      body: { password: "wrong-password-123" },
    });
    expect((await errorOf(keep)).code).toBe("AUTH_CURRENT_PASSWORD_INVALID");
    expect(
      (
        await admin.request("DELETE", "/api/backups/encryption", {
          body: { password: STRONG_PASSWORD },
        })
      ).status,
    ).toBe(200);
    expect(await json(await admin.get("/api/backups/encryption"))).toMatchObject({
      configured: false,
    });
    const job = await backupNow(ctx, admin);
    const refused = await admin.post(`/api/backups/${job.backupId}/download`, {
      password: STRONG_PASSWORD,
      encrypted: true,
    });
    expect((await errorOf(refused)).code).toBe("BACKUP_ENCRYPTION_REQUIRED");
  });

  it("restores another installation's backup with the passphrase only", async () => {
    // The first installation: a backup, downloaded encrypted.
    const first = await createTestContext({ masterKey: Buffer.alloc(32, 7) });
    const owner = new TestClient(first);
    await completeSetup(first, owner, "owner");
    await setPassphrase(owner);
    const notEncrypted = await owner.post(`/api/backups/${"20261018-101500-abcdef"}/download`, {
      password: STRONG_PASSWORD,
      encrypted: true,
    });
    expect(notEncrypted.status).toBe(404);
    const job = await backupNow(first, owner);
    const file = await encryptedDownload(owner, job.backupId!);
    expect(file.includes(Buffer.from('"hostname"'))).toBe(true);
    expect(file.includes(Buffer.from("SQLite format"))).toBe(false);

    // A new machine with its own secret and a temporary account.
    const second = await createTestContext({ masterKey: Buffer.alloc(32, 9) });
    const temporary = new TestClient(second);
    await completeSetup(second, temporary, "temporary");
    const uploaded = await temporary.request("POST", "/api/backups/upload", {
      rawBody: file,
      headers: {
        "content-length": String(file.length),
        "content-type": "application/octet-stream",
      },
    });
    expect(uploaded.status).toBe(202);
    const pending = await json<EncryptedUpload>(uploaded);
    expect(pending).toMatchObject({ encrypted: true, backupId: job.backupId, includesKey: true });
    const wrong = await temporary.post(`/api/backups/upload/${pending.uploadId}/decrypt`, {
      passphrase: "bu-parola-degil-ki",
    });
    expect((await errorOf(wrong)).code).toBe("BACKUP_PASSPHRASE_INVALID");
    const opened = await temporary.post(`/api/backups/upload/${pending.uploadId}/decrypt`, {
      passphrase: PASSPHRASE,
    });
    expect(opened.status).toBe(201);
    const view = await json<BackupView>(opened);
    expect(view).toMatchObject({
      id: job.backupId,
      uploaded: true,
      sameKey: false,
      keyAvailable: true,
      verification: { ok: true },
    });
    // The secret came along into the keyring, not into the backup directory.
    const keys = join(second.config.paths.dataDir, "keys");
    expect(readdirSync(keys)).toEqual([`${keyIdOf(Buffer.alloc(32, 7))}.key`]);
    expect(
      readdirSync(join(second.config.backups.dir, job.backupId!)).some((name) =>
        name.includes("secret"),
      ),
    ).toBe(false);
    expect(
      readdirSync(second.config.backups.dir).some((name) => name.startsWith(".encrypted-")),
    ).toBe(false);

    // The whole database can be restored; the next start brings the backup's secret with it.
    const preview = await json<RestorePreview>(
      await temporary.get(`/api/backups/${job.backupId}/preview`),
    );
    expect(preview.databaseBlocked).toBeNull();
    expect(
      (
        await temporary.post(`/api/backups/${job.backupId}/restore`, {
          settings: "database",
          apps: [],
          password: STRONG_PASSWORD,
          confirm: true,
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(() => expect(second.services.backups.job()).toBeNull(), { timeout: 20_000 });
    expect(second.services.backups.lastJob()).toMatchObject({ status: "succeeded" });
    const secretKeyFile = second.config.paths.secretKeyFile;
    writeFileSync(secretKeyFile, `${Buffer.alloc(32, 9).toString("base64url")}\n`, { mode: 0o600 });
    await applyPendingRestore({
      dataDir: second.config.paths.dataDir,
      databaseFile: second.config.paths.databaseFile,
      backupDir: second.config.paths.backupDir,
      secretKeyFile,
      keysDir: keys,
      logger: silentLogger,
    });
    expect(readFileSync(secretKeyFile, "utf8").trim()).toBe(
      Buffer.alloc(32, 7).toString("base64url"),
    );
    // The replaced secret stays usable for this machine's own older backups.
    expect(readdirSync(keys).sort()).toEqual(
      [`${keyIdOf(Buffer.alloc(32, 7))}.key`, `${keyIdOf(Buffer.alloc(32, 9))}.key`].sort(),
    );
  });

  it("keeps a plain-text upload working and refuses a damaged encrypted one", async () => {
    const ctx = await createTestContext();
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    await setPassphrase(admin);
    const job = await backupNow(ctx, admin);
    const file = await encryptedDownload(admin, job.backupId!);
    const truncated = await admin.request("POST", "/api/backups/upload", {
      rawBody: file.subarray(0, file.length - 1),
      headers: { "content-length": String(file.length - 1) },
    });
    expect((await errorOf(truncated)).code).toBe("BACKUP_INVALID");
    expect(readdirSync(ctx.config.backups.dir).some((name) => name.startsWith(".encrypted-"))).toBe(
      false,
    );
  });

  it("downloads the server secret only after the password, through a one-time link", async () => {
    const ctx = await createTestContext({ masterKey: Buffer.alloc(32, 3) });
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    const refused = await admin.post("/api/backups/secret-key", { password: "wrong-pass-123" });
    expect((await errorOf(refused)).code).toBe("AUTH_CURRENT_PASSWORD_INVALID");
    const { url } = await json<{ url: string }>(
      await admin.post("/api/backups/secret-key", { password: STRONG_PASSWORD }),
    );
    const response = await admin.get(url);
    expect(response.status).toBe(200);
    expect((await response.text()).trim()).toBe(Buffer.alloc(32, 3).toString("base64url"));
    expect((await admin.get(url)).status).toBe(403);
    const audit = ctx.db.all<{ details: string | null }>(
      "SELECT details FROM audit_events WHERE action = 'backups.secret-key.download'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details ?? "").not.toContain(Buffer.alloc(32, 3).toString("base64url"));
  });
});

/* -------------------------------------------------------------- off-site */

/** An in-memory, path-style S3 bucket (signatures are covered by the client's own tests). */
async function startFakeS3() {
  const objects = new Map<string, Buffer>();
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://s3");
    const [, bucket, ...rest] = url.pathname.split("/").map(decodeURIComponent);
    const key = rest.join("/");
    if (bucket !== "backups") {
      response.writeHead(404, { "Content-Type": "application/xml" });
      response.end("<Error><Code>NoSuchBucket</Code></Error>");
      return;
    }
    if (!String(request.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256 ")) {
      response.writeHead(403);
      response.end("<Error><Code>AccessDenied</Code></Error>");
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "PUT") {
        objects.set(key, Buffer.concat(chunks));
        response.writeHead(200, { ETag: '"etag"' });
        response.end();
      } else if (request.method === "DELETE") {
        objects.delete(key);
        response.writeHead(204);
        response.end();
      } else {
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...objects]
          .filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes("/"))
          .map(
            ([name, body]) =>
              `<Contents><Key>${name}</Key><Size>${body.length}</Size><LastModified>2026-10-18T10:00:00.000Z</LastModified></Contents>`,
          )
          .join("");
        response.writeHead(200, { "Content-Type": "application/xml" });
        response.end(
          `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    objects,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
});

const settings = (client: TestClient, body: object) =>
  client.request("PUT", "/api/backups/offsite", {
    body: { keep: 2, auto: true, password: STRONG_PASSWORD, ...body },
  });

describe("off-site copies", () => {
  it("copies encrypted backups to S3-compatible storage and keeps the newest", async () => {
    const s3 = await startFakeS3();
    closers.push(s3.close);
    const ctx = await createTestContext({ services: { s3: { retryDelayMs: 1 } } });
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    const target = {
      kind: "s3",
      endpoint: s3.endpoint,
      region: "us-east-1",
      bucket: "backups",
      prefix: "everyos",
      pathStyle: true,
      accessKeyId: "minio",
      secretAccessKey: "minio-secret-key",
    };
    // A wrong bucket is caught when saving.
    const wrongBucket = await settings(admin, { target: { ...target, bucket: "missing" } });
    expect(await errorOf(wrongBucket)).toMatchObject({
      code: "BACKUP_OFFSITE_FAILED",
      details: { reason: "s3:NoSuchBucket" },
    });
    const saved = await json<OffsiteView>(await settings(admin, { target }));
    expect(saved.target).toEqual({
      kind: "s3",
      endpoint: s3.endpoint,
      region: "us-east-1",
      bucket: "backups",
      prefix: "everyos/",
      pathStyle: true,
      accessKeyId: "minio",
    });
    expect(JSON.stringify(saved)).not.toContain("minio-secret-key");
    expect(
      ctx.db.get<{ value: string }>(
        "SELECT value FROM instance_settings WHERE key = 'backups.offsite'",
      )!.value,
    ).not.toContain("minio-secret-key");

    // Without a passphrase nothing goes off-site; the backup itself still works.
    const before = await backupNow(ctx, admin);
    expect(before.status).toBe("succeeded");
    expect(s3.objects.size).toBe(0);
    expect((await admin.post(`/api/backups/${before.backupId}/offsite`)).status).toBe(409);

    await setPassphrase(admin);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ctx.clock.now += 60_000;
      const job = await backupNow(ctx, admin);
      expect(job.status).toBe("succeeded");
      ids.push(job.backupId!);
    }
    // Saving again keeps the secret when it is left out.
    expect(
      (await settings(admin, { target: { ...target, secretAccessKey: undefined } })).status,
    ).toBe(200);
    expect([...s3.objects.keys()].sort()).toEqual(
      ids.slice(1).map((id) => `everyos/everyos-backup-${id}.eosbak`),
    );
    const copy = s3.objects.get(`everyos/everyos-backup-${ids[2]}.eosbak`)!;
    expect(copy.subarray(0, 8).toString()).toBe("EOSENC01");
    const view = await json<BackupView>(await admin.get(`/api/backups/${ids[2]}`));
    expect(view.offsite).toMatchObject({ ok: true, target: "S3 backups/everyos", error: null });

    // A manual copy of the oldest local one is a job of its own.
    expect((await admin.post(`/api/backups/${before.backupId}/offsite`)).status).toBe(202);
    await vi.waitFor(() => expect(ctx.services.backups.job()).toBeNull(), { timeout: 20_000 });
    expect(ctx.services.backups.lastJob()).toMatchObject({ kind: "offsite", status: "succeeded" });
  });

  it("records, notifies and audits a failed copy without failing the backup", async () => {
    const s3 = await startFakeS3();
    const ctx = await createTestContext({ services: { s3: { retryDelayMs: 1 } } });
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    await setPassphrase(admin);
    await settings(admin, {
      target: {
        kind: "s3",
        endpoint: s3.endpoint,
        region: "us-east-1",
        bucket: "backups",
        accessKeyId: "minio",
        secretAccessKey: "minio-secret-key",
      },
    });
    await s3.close();
    const job = await backupNow(ctx, admin);
    expect(job.status).toBe("succeeded");
    const view = await json<BackupView>(await admin.get(`/api/backups/${job.backupId}`));
    expect(view.offsite).toMatchObject({ ok: false, error: "s3:network" });
    const notifications = await json<NotificationList>(await admin.get("/api/notifications"));
    expect(notifications.notifications.map((entry) => entry.kind)).toContain(
      "backup-offsite-failed",
    );
    expect(
      ctx.db.get<{ outcome: string }>(
        "SELECT outcome FROM audit_events WHERE action = 'backups.offsite'",
      ),
    ).toEqual({ outcome: "failure" });
  });

  it("copies to a mounted disk folder, whole or not at all", async () => {
    const ctx = await createTestContext();
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    await setPassphrase(admin);
    const notMounted = await settings(admin, { target: { kind: "disk", uuid: USB } });
    expect(await errorOf(notMounted)).toMatchObject({ details: { reason: "disk-not-mounted" } });
    expect(
      (await admin.post("/api/system/disks/mount", { uuid: USB, persistent: false })).status,
    ).toBe(200);
    const saved = await json<OffsiteView>(
      await settings(admin, { target: { kind: "disk", uuid: USB, folder: "Yedekler" } }),
    );
    expect(saved.target).toMatchObject({ kind: "disk", uuid: USB, folder: "Yedekler" });
    const job = await backupNow(ctx, admin);
    const listing = await json<FileListing>(
      await admin.get(`/api/files/list?root=${diskRootId(USB)}&path=Yedekler&hidden=true`),
    );
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      `everyos-backup-${job.backupId}.eosbak`,
    ]);
    // Retention there deletes for good instead of filling the disk's trash.
    for (let i = 0; i < 2; i++) {
      ctx.clock.now += 60_000;
      await backupNow(ctx, admin);
    }
    const after = await json<FileListing>(
      await admin.get(`/api/files/list?root=${diskRootId(USB)}&path=Yedekler&hidden=true`),
    );
    expect(after.entries).toHaveLength(2);
    const trash = await json<{ entries: unknown[] }>(await admin.get("/api/files/trash"));
    expect(trash.entries).toHaveLength(0);
  });

  it("copies to the administrator's Google Drive folder", async () => {
    const google: FakeGoogle = await startFakeGoogle();
    closers.push(() => google.close());
    const ctx = await createTestContext({ services: { google: google.endpoints } });
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    await setPassphrase(admin);
    const unconnected = await settings(admin, { target: { kind: "drive" } });
    expect(await errorOf(unconnected)).toMatchObject({
      details: { reason: "drive-not-connected" },
    });
    await admin.request("PUT", "/api/drive/client", {
      body: { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-fake" },
    });
    const { url } = await json<{ url: string }>(
      await admin.post("/api/drive/connect", { redirectUri: "http://127.0.0.1:7470/" }),
    );
    const consent = await fetch(url, { redirect: "manual" });
    const back = new URL(consent.headers.get("location")!);
    await admin.post("/api/drive/connect/complete", {
      code: back.searchParams.get("code"),
      state: back.searchParams.get("state"),
    });
    const saved = await json<OffsiteView>(await settings(admin, { target: { kind: "drive" } }));
    expect(saved.target).toMatchObject({
      kind: "drive",
      folder: "EveryOS Backups",
      connected: true,
    });
    const job = await backupNow(ctx, admin);
    const folder = [...google.files.values()].find((file) => file.name === "EveryOS Backups")!;
    const copies = [...google.files.values()].filter((file) => file.parents.includes(folder.id));
    expect(copies.map((file) => file.name)).toEqual([`everyos-backup-${job.backupId}.eosbak`]);
    expect(copies[0]!.content!.subarray(0, 8).toString()).toBe("EOSENC01");
    expect(existsSync(join(ctx.config.backups.dir, job.backupId!))).toBe(true);
  });
});
