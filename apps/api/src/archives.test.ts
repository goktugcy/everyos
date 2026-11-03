import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js/index-native.js";
import { crc32 } from "node:zlib";
import { silentLogger } from "@everyos/logger";
import type { OperationContext, Actor } from "@everyos/agent-protocol";
import { AgentClientError, OperationError } from "@everyos/agent-protocol";
import { accountFiles } from "../../agent/src/account-files.ts";
import { AccountFileView } from "./modules/files/account-file-view.ts";
import { createZipTask, extractZipTask } from "./modules/files/zip-tasks.ts";
import type { ApiErrorBody, FileArchiveListing, TransferView } from "@everyos/shared";
import { openZip } from "./modules/files/zip-reader.ts";
import { describe, expect, it, vi } from "vitest";
import {
  completeSetup,
  createTestContext,
  json,
  STRONG_PASSWORD,
  TestClient,
} from "./test-support.ts";

/** A ZIP writer for adversarial fixtures; production encoders intentionally refuse these names. */
function zipFixture(
  items: Array<{
    name: string;
    data?: string;
    mode?: number;
    flags?: number;
    method?: number;
    size?: number;
    crc?: number;
    comment?: string;
  }>,
): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name);
    const data = Buffer.from(item.data ?? "");
    const comment = Buffer.from(item.comment ?? "");
    const checksum = item.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800 | (item.flags ?? 0), 6);
    local.writeUInt16LE(item.method ?? 0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(item.size ?? data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800 | (item.flags ?? 0), 8);
    record.writeUInt16LE(item.method ?? 0, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(item.size ?? data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(comment.length, 32);
    record.writeUInt32LE(
      ((item.mode ?? (item.name.endsWith("/") ? 0o040750 : 0o100640)) * 65536) >>> 0,
      38,
    );
    record.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(record, name, comment);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function setup(readOnly = false) {
  const ctx = await createTestContext({
    configure(config) {
      config.files.minFreeBytes = 0;
      if (readOnly) config.files.roots[0]!.readOnly = true;
    },
  });
  await ctx.services.files.ensureRoots();
  const admin = new TestClient(ctx);
  await completeSetup(ctx, admin);
  const root = ctx.config.files.roots[0]!;
  const wait = async (id: string) => {
    let transfer: TransferView | undefined;
    await vi.waitFor(
      async () => {
        const response = await json<{ transfers: TransferView[] }>(
          await admin.get("/api/transfers"),
        );
        transfer = response.transfers.find((item) => item.id === id);
        expect(transfer).toBeDefined();
        expect(["done", "failed", "cancelled"]).toContain(transfer!.state);
      },
      { timeout: 10_000, interval: 10 },
    );
    return transfer!;
  };
  const start = async (kind: "create" | "extract", body: Record<string, unknown>) => {
    const response = await admin.post(`/api/files/archive/${kind}`, { root: root.id, ...body });
    expect(response.status, await response.clone().text()).toBe(202);
    return (await json<{ transfer: TransferView }>(response)).transfer;
  };
  return { ctx, admin, root, wait, start };
}

describe("built-in ZIP files", () => {
  it("roundtrips through real account-file handlers with bounded remote range reads and closed transfers", async () => {
    const { ctx, admin, root } = await setup();
    const session = await json<{ user: { id: string; username: string }; session: { id: string } }>(
      await admin.get("/api/auth/session"),
    );
    const actor: Actor = {
      kind: "user",
      userId: session.user.id,
      username: session.user.username,
      role: "admin",
      sessionId: session.session.id,
      ip: "192.0.2.1",
    };
    const handlers = accountFiles({
      roots: [root],
      disksRoot: join(root.path, "unused-mounts"),
      home: root.path,
      userId: actor.userId,
      logger: silentLogger,
      maxUploadBytes: 1024 ** 3,
      minFreeBytes: 0,
    });
    const originalCall = ctx.agent.call.bind(ctx.agent);
    vi.spyOn(ctx.agent, "call").mockImplementation(((...args) => {
      if (args[3]?.signal?.aborted)
        return Promise.reject(new AgentClientError("AGENT_TIMEOUT", "Request cancelled"));
      return originalCall(...args);
    }) as typeof ctx.agent.call);
    const signal = new AbortController().signal;
    for (const [op, handler] of Object.entries(handlers)) {
      const invoke = handler as (params: unknown, context: OperationContext) => unknown;
      ctx.agent.handlers.set(op, async (params) => {
        try {
          return await invoke(params, { actor, signal, logger: silentLogger });
        } catch (error) {
          if (error instanceof OperationError)
            throw new AgentClientError("AGENT_OPERATION_FAILED", error.message, error.code);
          throw error;
        }
      });
    }
    const files = (operationSignal?: AbortSignal) =>
      new AccountFileView(ctx.services, ctx.services.files, {
        actor,
        locale: "tr",
        systemRoots: false,
        signal: operationSignal,
        logger: silentLogger,
      });
    const data = Buffer.from(Array.from({ length: 160_000 }, (_, i) => i % 256));
    writeFileSync(join(root.path, "large.bin"), data);
    const options = {
      root: root.id,
      path: "",
      name: "remote.zip",
      files,
      withAccess: <T>(run: () => Promise<T>) => run(),
      from: "source",
      to: "target",
    };
    const progress = { bytes: vi.fn(), item: vi.fn(), totals: vi.fn() };
    await createZipTask({ ...options, paths: ["large.bin"], minFreeBytes: 0 }).run(
      progress,
      signal,
    );
    const preview = await openZip(files(), root.id, "remote.zip", signal);
    expect(preview.listing.entries).toMatchObject([{ path: "large.bin", size: data.length }]);
    await preview.close();
    await extractZipTask({ ...options, path: "remote.zip", name: "remote-out" }).run(
      progress,
      signal,
    );
    expect(readFileSync(join(root.path, "remote-out", "large.bin"))).toEqual(data);
    const controller = new AbortController();
    const probe = await files(controller.signal).openFile(root.id, "remote.zip");
    controller.abort();
    await probe.handle.close();
    const opens = ctx.agent.calls.filter((call) => call.op === "files.download.open");
    const closes = ctx.agent.calls.filter((call) => call.op === "files.download.close");
    expect(closes).toHaveLength(opens.length);
    expect(
      ctx.agent.calls.filter((call) => call.op === "files.download.read").length,
    ).toBeGreaterThan(3);
  });
  it("compresses selected trees with Unicode, hidden files and empty folders, then extracts exact bytes", async () => {
    const { ctx, admin, root, start, wait } = await setup();
    mkdirSync(join(root.path, "Belgeler", "boş"), { recursive: true });
    writeFileSync(join(root.path, "Belgeler", "özgür.txt"), "Türkiye — exact UTF-8\n");
    writeFileSync(join(root.path, "Belgeler", ".hidden"), "hidden data");
    writeFileSync(join(root.path, "binary.bin"), Buffer.from([0, 255, 1, 128, 3]));
    const created = await start("create", {
      path: "",
      paths: ["Belgeler", "Belgeler/özgür.txt", "binary.bin"],
      name: "Arşiv.zip",
    });
    expect(await wait(created.id)).toMatchObject({ state: "done", error: null });
    const direct = await openZip(
      ctx.services.files,
      root.id,
      "Arşiv.zip",
      new AbortController().signal,
    );
    await direct.close();
    const listingResponse = await admin.get(
      `/api/files/archive?root=${root.id}&path=Ar%C5%9Fiv.zip`,
    );
    expect(listingResponse.status).toBe(200);
    const listing = await json<FileArchiveListing>(listingResponse);
    expect(listing.entries.map((entry) => entry.path).sort()).toEqual(
      ["Belgeler", "Belgeler/.hidden", "Belgeler/boş", "Belgeler/özgür.txt", "binary.bin"].sort(),
    );
    const extracted = await start("extract", { path: "Arşiv.zip", name: "Sonuç" });
    expect(await wait(extracted.id)).toMatchObject({ state: "done", error: null });
    expect(readFileSync(join(root.path, "Sonuç", "Belgeler", "özgür.txt"), "utf8")).toBe(
      "Türkiye — exact UTF-8\n",
    );
    expect(readFileSync(join(root.path, "Sonuç", "binary.bin"))).toEqual(
      Buffer.from([0, 255, 1, 128, 3]),
    );
    expect(readFileSync(join(root.path, "Sonuç", "Belgeler", ".hidden"), "utf8")).toBe(
      "hidden data",
    );
    expect(readdirSync(join(root.path, "Sonuç", "Belgeler", "boş"))).toEqual([]);
    expect(readdirSync(root.path).some((name) => name.startsWith(".everyos-archive-"))).toBe(false);
  });

  it("creates AES-256 ZIPs and never commits output before password authentication", async () => {
    const { admin, root, start, wait } = await setup();
    const password = "  Lâle🌷-synthetic-only  ";
    writeFileSync(join(root.path, "secret.txt"), "private UTF-8 payload: İstanbul 🌷");
    writeFileSync(join(root.path, "empty.txt"), "");
    const created = await start("create", {
      path: "",
      paths: ["secret.txt", "empty.txt"],
      name: "encrypted.zip",
      password,
    });
    expect(await wait(created.id)).toMatchObject({ state: "done", error: null });
    const preview = await json<FileArchiveListing>(
      await admin.get(`/api/files/archive?root=${root.id}&path=encrypted.zip`),
    );
    expect(preview.encrypted).toBe(true);
    expect(preview.entries.map((entry) => entry.path).sort()).toEqual(["empty.txt", "secret.txt"]);
    for (const attempt of [
      { name: "missing", error: "FILES_ARCHIVE_PASSWORD_REQUIRED" },
      { name: "wrong", password: "incorrect", error: "FILES_ARCHIVE_PASSWORD_INVALID" },
      { name: "trimmed", password: password.trim(), error: "FILES_ARCHIVE_PASSWORD_INVALID" },
    ]) {
      const { error, ...input } = attempt;
      const failed = await start("extract", { path: "encrypted.zip", ...input });
      expect(await wait(failed.id)).toMatchObject({ state: "failed", error });
      expect(existsSync(join(root.path, input.name))).toBe(false);
      expect(readdirSync(root.path).some((name) => name.startsWith(".everyos-archive-"))).toBe(
        false,
      );
    }
    const extracted = await start("extract", { path: "encrypted.zip", name: "opened", password });
    expect(await wait(extracted.id)).toMatchObject({ state: "done", error: null });
    expect(readFileSync(join(root.path, "opened", "secret.txt"), "utf8")).toBe(
      "private UTF-8 payload: İstanbul 🌷",
    );
    expect(readFileSync(join(root.path, "opened", "empty.txt"))).toHaveLength(0);
    expect(await (await admin.get("/api/transfers")).text()).not.toContain(password);
  });

  it.each([false, true])("opens encrypted input with ZipCrypto=%s", async (zipCrypto) => {
    const { root, start, wait } = await setup();
    const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    await zip.add("legacy.txt", new TextReader("encrypted fixture"), {
      password: "fixture-password",
      zipCrypto,
    });
    writeFileSync(join(root.path, "input.zip"), await zip.close());
    const transfer = await start("extract", {
      path: "input.zip",
      name: "opened",
      password: "fixture-password",
    });
    expect(await wait(transfer.id)).toMatchObject({ state: "done", error: null });
    expect(readFileSync(join(root.path, "opened", "legacy.txt"), "utf8")).toBe("encrypted fixture");
  });

  // Generated independently with pyzipper 0.3.6, AES-256, using only this synthetic payload/password.
  const independentAes = Buffer.from(
    "UEsDBBQAAQhjAHx+Y12XwRY6LAAAAA4AAAAQAAsAZMSxxZ9hcsSxZGFuLnR4dAGZBwABAEFFAwgAwcDbDzyqoTx+7c3nywYVyjMEGOW8s607O1O+L16d1dFMF0SxFFfyIDaOH59QSwECFAMUAAEIYwB8fmNdl8EWOiwAAAAOAAAAEAALAAAAAAAAAAAAgAEAAAAAZMSxxZ9hcsSxZGFuLnR4dAGZBwABAEFFAwgAUEsFBgAAAAABAAEASQAAAGUAAAAAAA==",
    "base64",
  );

  it("reads an independent AES-256 fixture", async () => {
    const { root, start, wait } = await setup();
    writeFileSync(join(root.path, "independent.zip"), independentAes);
    const transfer = await start("extract", {
      path: "independent.zip",
      name: "opened",
      password: "independent-fixture-only",
    });
    expect(await wait(transfer.id)).toMatchObject({ state: "done", error: null });
    expect(readFileSync(join(root.path, "opened", "dışarıdan.txt"), "utf8")).toBe("İstanbul 🌷");
  });

  it("rejects tampered AES authentication before publishing plaintext", async () => {
    const { root, start, wait } = await setup();
    const bytes = Buffer.from(independentAes);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const dataOffset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
    const macEnd = dataOffset + bytes.readUInt32LE(central + 20) - 1;
    bytes[macEnd] = bytes[macEnd]! ^ 1;
    writeFileSync(join(root.path, "tampered.zip"), bytes);
    const transfer = await start("extract", {
      path: "tampered.zip",
      name: "blocked",
      password: "independent-fixture-only",
    });
    expect(await wait(transfer.id)).toMatchObject({
      state: "failed",
      error: "FILES_ARCHIVE_PASSWORD_INVALID",
    });
    expect(existsSync(join(root.path, "blocked"))).toBe(false);
    expect(readdirSync(root.path).some((name) => name.startsWith(".everyos-archive-"))).toBe(false);
  });

  it("opens a forced ZIP64 archive with small files", async () => {
    const { root, start, wait } = await setup();
    const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    await zip.add("zip64.txt", new TextReader("ZIP64 payload"), { zip64: true });
    writeFileSync(join(root.path, "zip64.zip"), await zip.close(undefined, { zip64: true }));
    const transfer = await start("extract", { path: "zip64.zip", name: "zip64-out" });
    expect(await wait(transfer.id)).toMatchObject({ state: "done", error: null });
    expect(readFileSync(join(root.path, "zip64-out", "zip64.txt"), "utf8")).toBe("ZIP64 payload");
  });

  it.each([
    "../escape",
    "/escape",
    "dir/../../escape",
    "dir\\escape",
    "C:/escape",
    "file:stream",
    "CON.txt",
  ])("refuses unsafe ZIP path %s before writing anything", async (name) => {
    const { admin, root, start, wait } = await setup();
    writeFileSync(join(root.path, "unsafe.zip"), zipFixture([{ name, data: "must not escape" }]));
    const preview = await admin.get(`/api/files/archive?root=${root.id}&path=unsafe.zip`);
    expect(preview.status).toBe(400);
    const transfer = await start("extract", { path: "unsafe.zip", name: "blocked" });
    expect(await wait(transfer.id)).toMatchObject({
      state: "failed",
      error: "FILES_ARCHIVE_INVALID",
    });
    expect(existsSync(join(root.path, "blocked"))).toBe(false);
    expect(readdirSync(root.path)).toEqual(["unsafe.zip"]);
  });

  it("rejects duplicate, case-alias and file/directory collisions before extraction", async () => {
    const { admin, root } = await setup();
    for (const entries of [
      [{ name: "a" }, { name: "a" }],
      [{ name: "A" }, { name: "a" }],
      [{ name: "a" }, { name: "a/child" }],
    ]) {
      writeFileSync(join(root.path, "collision.zip"), zipFixture(entries));
      const result = await admin.get(`/api/files/archive?root=${root.id}&path=collision.zip`);
      expect(result.status).toBe(400);
      expect((await json<ApiErrorBody>(result)).error.code).toBe("FILES_ARCHIVE_INVALID");
    }
  });

  it("rejects unsupported encryption, symlinks and unsupported compression", async () => {
    const { admin, root } = await setup();
    for (const entry of [
      { name: "secret", flags: 0x41, data: "abcdefghijkl", size: 0 },
      { name: "link", mode: 0o120777 },
      { name: "data", method: 12 },
    ]) {
      writeFileSync(join(root.path, "unsupported.zip"), zipFixture([entry]));
      const result = await admin.get(`/api/files/archive?root=${root.id}&path=unsupported.zip`);
      expect(result.status).toBe(400);
      expect((await json<ApiErrorBody>(result)).error.code).toBe("FILES_ARCHIVE_UNSUPPORTED");
    }
  });

  it("bounds entry counts and expansion before creating an output folder", async () => {
    const { admin, root } = await setup();
    const excessive = zipFixture(Array.from({ length: 10001 }, (_, i) => ({ name: `item-${i}` })));
    for (const bytes of [
      excessive,
      zipFixture(
        Array.from({ length: 5 }, (_, i) => ({
          name: `bomb-${i}`,
          data: "x",
          method: 8,
          size: 0xfffffffe,
        })),
      ),
    ]) {
      writeFileSync(join(root.path, "limit.zip"), bytes);
      const result = await admin.get(`/api/files/archive?root=${root.id}&path=limit.zip`);
      expect(result.status).toBe(413);
      expect((await json<ApiErrorBody>(result)).error.code).toBe("FILES_ARCHIVE_LIMIT");
    }
  });

  it("bounds central directory metadata including entry comments", async () => {
    const { admin, root } = await setup();
    writeFileSync(
      join(root.path, "metadata.zip"),
      zipFixture(
        Array.from({ length: 280 }, (_, i) => ({
          name: `item-${i}`,
          comment: "x".repeat(60_000),
        })),
      ),
    );
    const result = await admin.get(`/api/files/archive?root=${root.id}&path=metadata.zip`);
    expect(result.status).toBe(413);
    expect((await json<ApiErrorBody>(result)).error.code).toBe("FILES_ARCHIVE_LIMIT");
  });

  it.each([
    {
      mode: "CRC",
      entry: { name: "bad.txt", data: "changed", crc: crc32(Buffer.from("original")) },
    },
    { mode: "deflate", entry: { name: "bad.txt", data: "not deflate", method: 8, size: 100 } },
  ])("rejects corrupt $mode data and removes the unpublished staging tree", async ({ entry }) => {
    const { root, start, wait } = await setup();
    writeFileSync(join(root.path, "broken.zip"), zipFixture([entry]));
    const transfer = await start("extract", { path: "broken.zip", name: "broken" });
    expect(await wait(transfer.id)).toMatchObject({
      state: "failed",
      error: "FILES_ARCHIVE_INVALID",
    });
    expect(existsSync(join(root.path, "broken"))).toBe(false);
    expect(readdirSync(root.path).some((name) => name.startsWith(".everyos-archive-"))).toBe(false);
  });

  it("does not replace existing destinations and enforces write permissions", async () => {
    const { ctx, admin, root } = await setup();
    writeFileSync(join(root.path, "source.zip"), zipFixture([{ name: "new.txt" }]));
    writeFileSync(join(root.path, "existing.zip"), "preserve this");
    mkdirSync(join(root.path, "existing"));
    expect(
      (
        await admin.post("/api/files/archive/create", {
          root: root.id,
          path: "",
          paths: ["source.zip"],
          name: "existing.zip",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await admin.post("/api/files/archive/extract", {
          root: root.id,
          path: "source.zip",
          name: "existing",
        })
      ).status,
    ).toBe(409);
    expect(readFileSync(join(root.path, "existing.zip"), "utf8")).toBe("preserve this");
    await admin.post("/api/users", {
      username: "viewer",
      displayName: "Viewer",
      password: STRONG_PASSWORD,
      role: "viewer",
      locale: "en",
    });
    const viewer = new TestClient(ctx, "192.0.2.12");
    await viewer.login("viewer", STRONG_PASSWORD);
    expect((await viewer.get(`/api/files/archive?root=${root.id}&path=source.zip`)).status).toBe(
      403,
    );
    expect(
      (
        await viewer.post("/api/files/archive/extract", {
          root: root.id,
          path: "source.zip",
          name: "denied",
        })
      ).status,
    ).toBe(403);
  });

  it("refuses writing into read-only roots and archiving symlinks", async () => {
    const readonly = await setup(true);
    writeFileSync(join(readonly.root.path, "source"), "source");
    expect(
      (
        await readonly.admin.post("/api/files/archive/create", {
          root: readonly.root.id,
          path: "",
          paths: ["source"],
          name: "result.zip",
        })
      ).status,
    ).toBe(403);
    const writable = await setup();
    writeFileSync(join(writable.root.path, "source"), "source");
    symlinkSync(join(writable.root.path, "source"), join(writable.root.path, "link"));
    const transfer = await writable.start("create", {
      path: "",
      paths: ["link"],
      name: "result.zip",
    });
    expect(await writable.wait(transfer.id)).toMatchObject({
      state: "failed",
      error: "FILES_ARCHIVE_UNSUPPORTED",
    });
    expect(existsSync(join(writable.root.path, "result.zip"))).toBe(false);
  });

  it("only discards reserved staging directories and does not follow a staging symlink", async () => {
    const { ctx, root } = await setup();
    mkdirSync(join(root.path, "keep"));
    writeFileSync(join(root.path, "keep", "note"), "keep me");
    await expect(ctx.services.files.discardArchiveStage(root.id, "keep")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const reserved = ".everyos-archive-00000000-0000-4000-8000-000000000001";
    symlinkSync(join(root.path, "keep"), join(root.path, reserved));
    await expect(ctx.services.files.discardArchiveStage(root.id, reserved)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(readFileSync(join(root.path, "keep", "note"), "utf8")).toBe("keep me");
  });

  it("cancels a queued archive without publishing a partial ZIP", async () => {
    const { admin, root, start, wait } = await setup();
    mkdirSync(join(root.path, "many"));
    for (let i = 0; i < 100; i++) writeFileSync(join(root.path, "many", `${i}.txt`), "data");
    const transfer = await start("create", { path: "", paths: ["many"], name: "cancelled.zip" });
    expect((await admin.post(`/api/transfers/${transfer.id}/cancel`, {})).status).toBe(200);
    expect((await wait(transfer.id)).state).toBe("cancelled");
    expect(existsSync(join(root.path, "cancelled.zip"))).toBe(false);
  });
});
