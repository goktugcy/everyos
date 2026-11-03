import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { initWasm, openWorkbook } from "@betteroffice/xlsx";
import { read } from "xlsx";
import { blankWorkbook, validateOfficeZip } from "../../../packages/office-core/src/container.ts";
import { convertLegacyWorkbook } from "../../../packages/office-core/src/legacy.ts";
import { importCsv, exportCsv } from "../../../packages/office-core/src/csv.ts";

const fixture = () =>
  new Uint8Array(readFileSync(resolve("packages/office-core/test/fixtures/legacy.xls")));
beforeAll(async () => {
  await initWasm(
    new Uint8Array(
      readFileSync(
        resolve(
          "official-apps/excel/node_modules/@betteroffice/xlsx/dist/generated/xlsx_wasm_bg.wasm",
        ),
      ),
    ),
  );
});

describe("Excel workbooks", () => {
  it("creates an empty workbook with a real, localized sheet", async () => {
    const bytes = await blankWorkbook("Sayfa & 1");
    await validateOfficeZip(bytes, "xlsx");
    const workbook = read(bytes, { type: "array" });
    expect(workbook.SheetNames).toEqual(["Sayfa & 1"]);
    expect(workbook.Sheets["Sayfa & 1"]?.A1).toBeUndefined();
  });
  it("imports a real BIFF workbook and preserves its data, sheets and formats without changing the source", async () => {
    const source = fixture();
    const original = source.slice();
    const bytes = convertLegacyWorkbook(source);
    await validateOfficeZip(bytes, "xlsx");
    const book = read(bytes, { type: "array", cellNF: true });
    expect(book.SheetNames).toEqual(["Hesap", "İkinci"]);
    expect(book.Sheets.Hesap?.A1?.v).toBe(21);
    expect(book.Sheets.Hesap?.A2?.f).toBe("SUM(A1:B1)");
    expect(book.Sheets.Hesap?.A3?.v).toBe("İstanbul 🌷");
    expect(book.Sheets.Hesap?.A4?.z).toBe("0.00");
    expect(source).toEqual(original);
  });
  it("edits cells, recalculates dependent formulas and saves a reopenable workbook", () => {
    const book = openWorkbook(convertLegacyWorkbook(fixture()));
    try {
      expect(book.editCell(0, 0, 0, "40").applied).toBe(true);
      const result = book.readCells({
        ranges: [{ sheetId: book.sheetInfo().sheetIds[0]!, range: { kind: "a1", a1: "A2" } }],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Could not read the recalculated cell");
      expect(result.ranges[0]?.cells[0]?.[0]?.value).toEqual({ kind: "number", value: 42 });
      const saved = read(book.save(), { type: "array" });
      expect(saved.Sheets.Hesap?.A1?.v).toBe(40);
      expect(saved.Sheets.Hesap?.A2?.f).toBe("SUM(A1:B1)");
      expect(saved.SheetNames).toEqual(["Hesap", "İkinci"]);
    } finally {
      book.dispose();
    }
  });
  it("refuses unrelated binary data", () => {
    expect(() => convertLegacyWorkbook(new Uint8Array([1, 2, 3]))).toThrow("invalid");
  });
  it("imports quoted CSV, Unicode, embedded newlines and literal formula text without losing identifiers", async () => {
    const input =
      '\ufeffName,ID,Amount,Note\r\nİstanbul,00123,21,"a,b"\r\n"şeker 🌷",12345678901234567890,2,"line 1\nline ""2"""\r\n=1+2,,0,last\r\n';
    const { bytes, settings } = importCsv(new TextEncoder().encode(input), "Veriler");
    await validateOfficeZip(bytes, "xlsx");
    const book = read(bytes, { type: "array" });
    expect(book.SheetNames).toEqual(["Veriler"]);
    expect(book.Sheets.Veriler?.B2?.v).toBe("00123");
    expect(book.Sheets.Veriler?.B3?.v).toBe("12345678901234567890");
    expect(book.Sheets.Veriler?.C2?.v).toBe(21);
    expect(book.Sheets.Veriler?.D3?.v).toBe('line 1\nline "2"');
    expect(book.Sheets.Veriler?.A4).toMatchObject({ t: "s", v: "=1+2" });
    expect(book.Sheets.Veriler?.A4?.f).toBeUndefined();
    const exported = exportCsv(bytes, settings);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(exported.bytes)).toBe(
      input.replace('"şeker 🌷"', "şeker 🌷"),
    );
  });
  it.each([";", "\t"])(
    "detects the %s delimiter and saves actual editor changes as CSV",
    (delimiter) => {
      const source = new TextEncoder().encode(
        "Name" + delimiter + 'Count\n"İstanbul, Türkiye"' + delimiter + "21",
      );
      const imported = importCsv(source, "Veriler");
      expect(imported.settings.delimiter).toBe(delimiter);
      const editor = openWorkbook(imported.bytes);
      try {
        expect(editor.editCell(0, 1, 1, "42").applied).toBe(true);
        const output = exportCsv(editor.save(), imported.settings);
        const reopened = read(importCsv(output.bytes, "Veriler").bytes, { type: "array" });
        expect(reopened.Sheets.Veriler?.B2?.v).toBe(42);
        expect(reopened.Sheets.Veriler?.A2?.v).toBe("İstanbul, Türkiye");
        expect(new TextDecoder().decode(output.bytes)).not.toMatch(/[\r\n]$/);
      } finally {
        editor.dispose();
      }
    },
  );
  it("preserves UTF-16 BOM and Excel separator lines", () => {
    const text = "\ufeffsep=;\r\nİsim;Değer\r\nİstanbul;5\r\n";
    const input = new Uint8Array(text.length * 2);
    const view = new DataView(input.buffer);
    for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
    const imported = importCsv(input, "Veriler");
    expect(imported.settings).toMatchObject({
      encoding: "utf-16le",
      separatorLine: true,
      delimiter: ";",
    });
    expect(exportCsv(imported.bytes, imported.settings).bytes).toEqual(input);
  });
  it("rejects malformed quotes, invalid text encoding and excessive cell text", () => {
    for (const text of ['a,b\n"unterminated,c', 'a,b\n"x"extra,c', 'a,b\nnot"quoted,c'])
      expect(() => importCsv(new TextEncoder().encode(text), "Data")).toThrow("invalid");
    expect(() => importCsv(new Uint8Array([0xff, 0xff]), "Data")).toThrow("invalid");
    expect(() => importCsv(new TextEncoder().encode("x".repeat(32768)), "Data")).toThrow(
      "tooLarge",
    );
  });
});
