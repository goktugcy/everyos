import { describe, expect, it } from "vitest";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js/index-native.js";
import { validateOfficeZip, wordDocument, writeOfficeParts } from "./container.ts";

describe("untrusted Office containers", () => {
  it("rejects a package for the wrong editor and missing document parts", async () => {
    await expect(validateOfficeZip(await wordDocument(), "xlsx")).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      validateOfficeZip(await writeOfficeParts({ "[Content_Types].xml": "<Types/>" }), "docx"),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects XML entity declarations before passing data to the editor", async () => {
    const bytes = await wordDocument(
      '<!DOCTYPE foo [<!ENTITY leak SYSTEM "file:///private">]><w:p>&leak;</w:p>',
    );
    await expect(validateOfficeZip(bytes, "docx")).rejects.toMatchObject({ code: "invalid" });
  });

  it("checks the CRC of payloads even when the ZIP directory is intact", async () => {
    const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 });
    await zip.add("[Content_Types].xml", new TextReader("<Types/>"));
    await zip.add("word/document.xml", new TextReader("<document>unique-payload</document>"));
    const bytes = await zip.close();
    const offset = Buffer.from(bytes).indexOf("unique-payload");
    expect(offset).toBeGreaterThan(0);
    bytes[offset] = bytes[offset]! ^ 1;
    await expect(validateOfficeZip(bytes, "docx")).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses encrypted entries without requesting or retaining passwords", async () => {
    const zip = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
      password: "test-only",
      encryptionStrength: 3,
    });
    await zip.add("[Content_Types].xml", new TextReader("<Types/>"));
    await expect(validateOfficeZip(await zip.close(), "docx")).rejects.toMatchObject({
      code: "encrypted",
    });
  });

  it("rejects inflated sizes from the directory before decompression", async () => {
    const bytes = await wordDocument();
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const directory = Buffer.from(bytes).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(directory).toBeGreaterThan(0);
    data.setUint32(directory + 24, 65 * 1024 ** 2, true);
    await expect(validateOfficeZip(bytes, "docx")).rejects.toMatchObject({ code: "tooLarge" });
  });

  it("honors cancellation before opening an otherwise valid document", async () => {
    await expect(
      validateOfficeZip(await wordDocument(), "docx", AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
