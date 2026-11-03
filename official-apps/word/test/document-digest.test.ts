import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { documentDigest, installDocumentDigest } from "../src/document-digest.ts";

describe("document hashes on HTTP origins", () => {
  it.each(["", "abc", "İstanbul 🌷"])("matches native SHA-256 for %s", async (text) => {
    const data = new TextEncoder().encode(text);
    const digest = await documentDigest().digest("SHA-256", data);
    expect(Buffer.from(digest).toString("hex")).toBe(
      createHash("sha256").update(data).digest("hex"),
    );
  });
  it("hashes only the requested view and rejects unsupported algorithms", async () => {
    const bytes = new Uint8Array([0, 97, 98, 99, 0]);
    const digest = await documentDigest().digest({ name: "SHA-256" }, bytes.subarray(1, 4));
    expect(Buffer.from(digest).toString("hex")).toBe(
      createHash("sha256").update("abc").digest("hex"),
    );
    await expect(documentDigest().digest("MD5", bytes)).rejects.toMatchObject({
      name: "NotSupportedError",
    });
  });
  it("leaves an existing native implementation intact", () => {
    const native = { digest: () => Promise.resolve(new ArrayBuffer(0)) };
    const target = { subtle: native } as unknown as Crypto;
    installDocumentDigest(target);
    expect(target.subtle).toBe(native);
  });
  it("snapshots the caller's bytes before asynchronous digesting", async () => {
    const bytes = new TextEncoder().encode("abc");
    const pending = documentDigest().digest("SHA-256", bytes);
    bytes.fill(0);
    expect(Buffer.from(await pending).toString("hex")).toBe(
      createHash("sha256").update("abc").digest("hex"),
    );
  });
});
