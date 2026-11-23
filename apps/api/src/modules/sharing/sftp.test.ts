import { createHash, generateKeyPairSync } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  writeFile,
  readdir,
  lstat,
  realpath,
  rename,
  unlink,
  rmdir,
  symlink,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, posix } from "node:path";
import { once } from "node:events";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { Server, utils, type Connection } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, completeSetup, TestClient, json } from "../../test-support.ts";
import type { NetworkConnection, TransferView } from "@everyos/shared";
import { SftpFiles, SftpPool, unsafeNetworkAddress } from "./sftp.ts";

const privatePem = () =>
  generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
const hostKey = privatePem(),
  loginKey = privatePem();
const parsedHost = utils.parseKey(hostKey),
  parsedLogin = utils.parseKey(loginKey);
if (
  parsedHost instanceof Error ||
  Array.isArray(parsedHost) ||
  parsedLogin instanceof Error ||
  Array.isArray(parsedLogin)
)
  throw new Error("Invalid test keys");
const fingerprint =
  "SHA256:" +
  createHash("sha256").update(parsedHost.getPublicSSH()).digest("base64").replace(/=+$/, "");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Actual SSH encryption/authentication and SFTP packets, backed only by a disposable local tree. */
async function fixture(closeDelayMs = 0) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "everyos-sftp-")));
  await mkdir(join(root, "vault"));
  const clients = new Set<Connection>();
  let passwordAttempts = 0,
    keyAttempts = 0,
    pendingCloses = 0;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => undefined);
    client.on("authentication", (ctx) => {
      if (ctx.username !== "fixture") {
        ctx.reject();
        return;
      }
      if (ctx.method === "password") {
        passwordAttempts++;
        if (ctx.password === "fixture-password") ctx.accept();
        else ctx.reject();
      } else if (ctx.method === "publickey") {
        keyAttempts++;
        if (
          parsedLogin instanceof Error ||
          Array.isArray(parsedLogin) ||
          !ctx.key.data.equals(parsedLogin.getPublicSSH()) ||
          (ctx.signature && !parsedLogin.verify(ctx.blob!, ctx.signature, ctx.hashAlgo))
        )
          ctx.reject();
        else ctx.accept();
      } else ctx.reject(["password", "publickey"]);
    });
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => {
          const s = acceptSftp();
          const handles = new Map<
            string,
            { file?: FileHandle; names?: string[]; cursor?: number; local: string }
          >();
          let sequence = 0;
          const local = (remote: string) => {
            const canonical = posix.resolve("/", remote);
            if (canonical !== "/vault" && !canonical.startsWith("/vault/"))
              throw Object.assign(new Error("Denied"), { code: "EACCES" });
            const target = resolve(root, "." + canonical);
            if (!target.startsWith(root + "/")) throw new Error("Denied");
            return target;
          };
          const status = (id: number, error?: unknown) =>
            s.status(
              id,
              !error
                ? 0
                : (error as NodeJS.ErrnoException).code === "ENOENT"
                  ? 2
                  : (error as NodeJS.ErrnoException).code === "EACCES"
                    ? 3
                    : 4,
            );
          const run = (id: number, task: () => Promise<void>) => {
            void task().catch((error: unknown) => status(id, error));
          };
          const attrs = async (path: string) => {
            const a = await lstat(path);
            return {
              size: a.size,
              uid: a.uid,
              gid: a.gid,
              mode: a.mode,
              atime: Math.floor(a.atimeMs / 1000),
              mtime: Math.floor(a.mtimeMs / 1000),
            };
          };
          s.on("REALPATH", (id, path) =>
            run(id, async () => {
              const canonical = await realpath(local(path));
              s.name(id, [
                {
                  filename: "/" + relative(root, canonical),
                  longname: path,
                  attrs: await attrs(canonical),
                },
              ]);
            }),
          );
          s.on("STAT", (id, path) =>
            run(id, async () => {
              s.attrs(id, await attrs(local(path)));
            }),
          );
          s.on("LSTAT", (id, path) =>
            run(id, async () => {
              s.attrs(id, await attrs(local(path)));
            }),
          );
          s.on("OPEN", (id, path, flags, a) =>
            run(id, async () => {
              const target = local(path);
              const f = await open(
                target,
                flags & 8 ? (flags & 32 ? "wx" : "w") : "r",
                a.mode ?? 0o600,
              );
              const handle = Buffer.from(String(++sequence));
              handles.set(handle.toString(), { file: f, local: target });
              s.handle(id, handle);
            }),
          );
          s.on("FSTAT", (id, handle) =>
            run(id, async () => {
              const item = handles.get(handle.toString());
              if (!item) throw new Error("Missing handle");
              s.attrs(id, await attrs(item.local));
            }),
          );
          s.on("READ", (id, handle, offset, length) =>
            run(id, async () => {
              const item = handles.get(handle.toString());
              if (!item?.file) throw new Error("Missing handle");
              const data = Buffer.alloc(Math.min(length, 64 * 1024));
              const result = await item.file.read(data, 0, data.length, offset);
              if (!result.bytesRead) s.status(id, 1);
              else s.data(id, data.subarray(0, result.bytesRead));
            }),
          );
          s.on("WRITE", (id, handle, offset, data) =>
            run(id, async () => {
              const item = handles.get(handle.toString());
              if (!item?.file) throw new Error("Missing handle");
              await item.file.write(data, 0, data.length, offset);
              status(id);
            }),
          );
          s.on("CLOSE", (id, handle) =>
            run(id, async () => {
              pendingCloses++;
              const item = handles.get(handle.toString());
              handles.delete(handle.toString());
              await item?.file?.close();
              if (closeDelayMs) await new Promise((resolve) => setTimeout(resolve, closeDelayMs));
              pendingCloses--;
              status(id);
            }),
          );
          s.on("OPENDIR", (id, path) =>
            run(id, async () => {
              const target = local(path),
                names = await readdir(target),
                handle = Buffer.from(String(++sequence));
              handles.set(handle.toString(), { local: target, names, cursor: 0 });
              s.handle(id, handle);
            }),
          );
          s.on("READDIR", (id, handle) =>
            run(id, async () => {
              const item = handles.get(handle.toString());
              if (!item?.names) throw new Error("Missing directory");
              const names = item.names.slice(item.cursor ?? 0, (item.cursor ?? 0) + 50);
              item.cursor = (item.cursor ?? 0) + names.length;
              if (!names.length) {
                s.status(id, 1);
                return;
              }
              s.name(
                id,
                await Promise.all(
                  names.map(async (name) => ({
                    filename: name,
                    longname: name,
                    attrs: await attrs(join(item.local, name)),
                  })),
                ),
              );
            }),
          );
          s.on("MKDIR", (id, path, a) =>
            run(id, async () => {
              await mkdir(local(path), { mode: a.mode ?? 0o700 });
              status(id);
            }),
          );
          s.on("RMDIR", (id, path) =>
            run(id, async () => {
              await rmdir(local(path));
              status(id);
            }),
          );
          s.on("REMOVE", (id, path) =>
            run(id, async () => {
              await unlink(local(path));
              status(id);
            }),
          );
          s.on("RENAME", (id, from, to) =>
            run(id, async () => {
              const destination = local(to);
              const exists = await lstat(destination).then(
                () => true,
                () => false,
              );
              if (exists) throw new Error("Exists");
              await rename(local(from), destination);
              status(id);
            }),
          );
          s.on("close", () => {
            for (const h of handles.values()) void h.file?.close();
            handles.clear();
          });
        });
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const pool = new SftpPool({ allowLoopback: true });
  cleanups.push(async () => {
    pool.close();
    for (const client of clients) client.end();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  });
  const connection: NetworkConnection = {
    id: "29c6f8ee-7500-48ca-b826-34b676a9ef66",
    name: "Protocol fixture",
    protocol: "sftp",
    host: "127.0.0.1",
    port,
    remotePath: "/vault",
    username: "fixture",
    readOnly: false,
    enabled: true,
    persistent: false,
    automount: true,
    version: "sftp",
    fingerprint,
    root: "net-29c6f8ee750048cab82634b6",
    mountPoint: null,
    state: "disconnected",
    reason: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const files = (credentials = { password: "fixture-password" }) =>
    new SftpFiles({
      connection,
      credentials,
      pool,
      maxUploadBytes: 4 * 1024 ** 2,
      owner: "fixture-owner",
    });
  return {
    root,
    pool,
    connection,
    files,
    passwordAttempts: () => passwordAttempts,
    keyAttempts: () => keyAttempts,
    pendingCloses: () => pendingCloses,
  };
}

describe("real SSH/SFTP transport", () => {
  it("probes without credentials and refuses changed keys before authentication", async () => {
    const f = await fixture();
    expect(await f.pool.probe("127.0.0.1", f.connection.port)).toBe(fingerprint);
    expect(f.passwordAttempts()).toBe(0);
    f.connection.fingerprint =
      "SHA256:" + Buffer.alloc(32, 7).toString("base64").replace(/=+$/, "");
    await expect(f.files().list(f.connection.root, "", true)).rejects.toMatchObject({
      code: "SHARING_HOST_KEY",
    });
    expect(f.passwordAttempts()).toBe(0);
  });
  it("authenticates, streams real bytes, lists, searches, renames and removes within the selected root", async () => {
    const f = await fixture(),
      files = f.files();
    await files.mkdir(f.connection.root, "", "folder");
    const bytes = Buffer.alloc(512 * 1024, 0x65);
    await files.upload(
      f.connection.root,
      "folder",
      "fixture.bin",
      Readable.toWeb(Readable.from([bytes])) as WebReadableStream<Uint8Array>,
      bytes.length,
      false,
    );
    expect(await readFile(join(f.root, "vault/folder/fixture.bin"))).toEqual(bytes);
    const opened = await files.openFile(f.connection.root, "folder/fixture.bin");
    const chunks: Buffer[] = [];
    for await (const chunk of opened.handle.createReadStream({ start: 7, end: 106 }))
      chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks)).toEqual(bytes.subarray(7, 107));
    await opened.handle.close();
    expect((await files.list(f.connection.root, "folder", false)).entries).toEqual([
      expect.objectContaining({ name: "fixture.bin", type: "file", size: bytes.length }),
    ]);
    expect((await files.search(f.connection.root, "", "fixture")).results).toEqual([
      expect.objectContaining({ path: "folder/fixture.bin" }),
    ]);
    await files.rename(f.connection.root, "folder/fixture.bin", "renamed.bin");
    await files.remove(f.connection.root, ["folder"]);
    expect((await files.list(f.connection.root, "", true)).entries).toEqual([]);
    expect(f.passwordAttempts()).toBe(1);
  });
  it("acknowledges delayed remote handle closure before completing text reads", async () => {
    const f = await fixture(40);
    await writeFile(join(f.root, "vault/text.txt"), "A real remote text document");
    expect((await f.files().readText(f.connection.root, "text.txt")).content).toBe(
      "A real remote text document",
    );
    expect(f.pendingCloses()).toBe(0);
    f.pool.close();
  });
  it("supports private keys and rejects bad passwords without leaking provider errors", async () => {
    const f = await fixture();
    const lease = await f.pool.acquire(
      f.connection,
      { privateKey: loginKey },
      undefined,
      "fixture-owner",
    );
    lease.release();
    expect(f.keyAttempts()).toBeGreaterThan(0);
    f.pool.close(f.connection.id);
    await expect(
      f.files({ password: "incorrect-secret" }).list(f.connection.root, "", false),
    ).rejects.toMatchObject({ code: "SHARING_AUTH_FAILED" });
  });
  it("cancels an active streamed upload and cleans its remote temporary file", async () => {
    const f = await fixture(),
      controller = new AbortController();
    const files = new SftpFiles({
      connection: f.connection,
      pool: f.pool,
      credentials: { password: "fixture-password" },
      owner: "fixture-owner",
      signal: controller.signal,
      maxUploadBytes: 4 * 1024 ** 2,
    });
    const source = Readable.from(
      (async function* () {
        yield Buffer.alloc(256 * 1024, 0x61);
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.abort();
        yield Buffer.alloc(256 * 1024, 0x62);
      })(),
    );
    await expect(
      files.upload(
        f.connection.root,
        "",
        "cancelled.bin",
        Readable.toWeb(source) as WebReadableStream<Uint8Array>,
        4 * 1024 ** 2,
        false,
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(
      (await readdir(join(f.root, "vault"))).filter(
        (n) => n === "cancelled.bin" || n.startsWith(".everyos-upload-"),
      ),
    ).toEqual([]);
  });
  it("rejects traversal, symlink reads, collisions, read-only writes and excessive lengths", async () => {
    const f = await fixture(),
      files = f.files();
    await expect(files.list(f.connection.root, "../", false)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await symlink("../outside.txt", join(f.root, "vault/link"));
    await expect(files.openFile(f.connection.root, "link")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const source = () =>
      Readable.toWeb(Readable.from([Buffer.from("data")])) as WebReadableStream<Uint8Array>;
    await files.upload(f.connection.root, "", "same.txt", source(), 4, false);
    await expect(
      files.upload(f.connection.root, "", "same.txt", source(), 4, false),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    f.connection.readOnly = true;
    await expect(files.mkdir(f.connection.root, "", "blocked")).rejects.toMatchObject({
      code: "FILES_READ_ONLY",
    });
    f.connection.readOnly = false;
    await expect(
      files.upload(f.connection.root, "", "too-big.txt", source(), 5 * 1024 ** 2, false),
    ).rejects.toMatchObject({ code: "FILES_TOO_LARGE" });
    await expect(
      files.upload(f.connection.root, "", "short.txt", source(), 5, false),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(
      (await readdir(join(f.root, "vault"))).some((n) => n.startsWith(".everyos-upload-")),
    ).toBe(false);
  });
  it("blocks loopback, metadata, mapped loopback and multicast destinations by default", () => {
    for (const ip of [
      "127.0.0.1",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "169.254.169.254",
      "0.0.0.0",
      "224.0.0.1",
      "fe80::1",
    ])
      expect(unsafeNetworkAddress(ip)).toBe(true);
    for (const ip of ["192.168.1.2", "10.3.2.1", "100.64.1.2", "fd00::12"])
      expect(unsafeNetworkAddress(ip)).toBe(false);
  });
  it("runs actual Files API transfers from local storage to SFTP and between two SSH servers", async () => {
    const first = await fixture(),
      second = await fixture();
    const ctx = await createTestContext({ services: { sharingAllowLoopback: true } });
    cleanups.push(() => {
      ctx.services.transfers.stop();
      ctx.services.sharing.close();
      return Promise.resolve();
    });
    const admin = new TestClient(ctx);
    await completeSetup(ctx, admin);
    const save = async (port: number, name: string) => {
      const response = await admin.post("/api/sharing/connections", {
        name,
        protocol: "sftp",
        host: "127.0.0.1",
        port,
        remotePath: "/vault",
        username: "fixture",
        password: "fixture-password",
        fingerprint,
        version: "sftp",
        confirm: true,
        readOnly: false,
      });
      expect(response.status).toBe(201);
      return json<NetworkConnection>(response);
    };
    const a = await save(first.connection.port, "First"),
      b = await save(second.connection.port, "Second");
    expect(
      (await admin.post("/api/files/mkdir", { root: "home", path: "", name: "tree" })).status,
    ).toBe(201);
    for (let i = 0; i < 20; i++)
      expect(
        (
          await admin.request("PUT", "/api/files/text", {
            body: {
              root: "home",
              path: "tree/" + i + ".txt",
              content: "actual bytes " + i,
              etag: null,
            },
          })
        ).status,
      ).toBe(200);
    const transfer = async (
      root: string,
      paths: string[],
      destination: { root: string; path: string },
    ) => {
      const response = await admin.post("/api/files/copy", { root, paths, destination });
      expect(response.status).toBe(202);
      const { transfer } = await json<{ transfer: TransferView }>(response);
      const owner = ctx.services.users.findByUsername("admin")!.id;
      await expect
        .poll(() => ctx.services.transfers.list(owner).find((j) => j.id === transfer.id)?.state, {
          timeout: 10000,
        })
        .toBe("done");
      return ctx.services.transfers.list(owner).find((j) => j.id === transfer.id)!;
    };
    const sent = await transfer("home", ["tree"], { root: a.root, path: "" });
    expect(sent.itemsDone).toBe(20);
    expect(sent.bytesDone).toBeGreaterThan(200);
    await transfer(a.root, ["tree"], { root: b.root, path: "" });
    expect(await readFile(join(second.root, "vault/tree/19.txt"), "utf8")).toBe("actual bytes 19");
    const download = await admin.get("/api/files/download?root=" + b.root + "&path=tree%2F19.txt");
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("actual bytes 19");
    const publicRows = ctx.services.sharing.connections({
      kind: "user",
      role: "operator",
      username: "other",
      userId: "not-owner",
    });
    expect(publicRows).toEqual([]);
    const sealed = ctx.db.get<{ sealed_credentials: string }>(
      "SELECT sealed_credentials FROM network_connections WHERE id=?",
      a.id,
    )!;
    expect(sealed.sealed_credentials).not.toContain("fixture-password");
    await admin.post("/api/sharing/connections/" + a.id + "/control", {
      action: "disconnect",
      confirm: true,
    });
    expect(ctx.services.sharing.pool.isConnected(a.id)).toBe(false);
  }, 20000);
});
