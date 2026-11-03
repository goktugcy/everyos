import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TextWriter, Uint8ArrayReader, ZipReader } from "@zip.js/zip.js/index-native.js";
import { convertLegacyDoc } from "../../../packages/office-core/src/legacy.ts";
import { validateOfficeZip, wordDocument } from "../../../packages/office-core/src/container.ts";

const fixture = () =>
  new Uint8Array(readFileSync(resolve("packages/office-core/test/fixtures/legacy.doc")));
async function documentXml(bytes: Uint8Array) {
  const zip = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  try {
    const entry = (await zip.getEntries()).find((item) => item.filename === "word/document.xml");
    if (!entry || entry.directory) throw new Error("Missing document");
    return await entry.getData(new TextWriter(), { checkSignature: true });
  } finally {
    await zip.close();
  }
}

describe("Word documents", () => {
  it("creates a genuine blank DOCX", async () => {
    const bytes = await wordDocument();
    await expect(validateOfficeZip(bytes, "docx")).resolves.toBeUndefined();
    expect(await documentXml(bytes)).toContain("<w:p/>");
  });
  it("imports an independently generated binary DOC with Unicode, formatting and table cells", async () => {
    const source = fixture();
    const original = source.slice();
    const bytes = await convertLegacyDoc(source, {});
    await expect(validateOfficeZip(bytes, "docx")).resolves.toBeUndefined();
    const xml = await documentXml(bytes);
    expect(xml).toContain("Fixture title");
    expect(xml).toContain("İstanbul");
    expect(xml).toContain("şeker");
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain("Cell A");
    expect(xml).toContain("Cell B");
    expect(xml).toContain("<w:tbl>");
    expect(source).toEqual(original);
  });
  it("refuses non-DOC and malformed data", async () => {
    await expect(
      convertLegacyDoc(new TextEncoder().encode("not a document"), {}),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      convertLegacyDoc(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), {}),
    ).rejects.toMatchObject({ code: "conversion" });
  });
});
