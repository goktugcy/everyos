import {
  Reader,
  ZipReader,
  ZipWriter,
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
} from "@zip.js/zip.js/index-native.js";

export type OfficeFormat = "docx" | "xlsx";
export type OfficeErrorCode = "invalid" | "tooLarge" | "encrypted" | "timeout" | "conversion";

export class OfficeError extends Error {
  readonly code: OfficeErrorCode;
  constructor(code: OfficeErrorCode) {
    super(code);
    this.name = "OfficeError";
    this.code = code;
  }
}

export const MAX_OFFICE_BYTES = 20 * 1024 ** 2;
export const MAX_OFFICE_CONTENT = 64 * 1024 ** 2;
const MAX_ENTRIES = 4096;
const MAX_DIRECTORY = 2 * 1024 ** 2;

class BoundedReader extends Reader<unknown> {
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    super(undefined);
    this.bytes = bytes;
    this.size = bytes.length;
  }
  override readUint8Array(offset: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.size
    )
      return Promise.reject(new OfficeError("invalid"));
    if (length > MAX_DIRECTORY) return Promise.reject(new OfficeError("tooLarge"));
    return Promise.resolve(this.bytes.subarray(offset, offset + length));
  }
}

export function isCompoundFile(bytes: Uint8Array): boolean {
  return [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, i) => bytes[i] === byte);
}

/** Validate every payload before a second parser can allocate from attacker-controlled ZIP sizes. */
export async function validateOfficeZip(
  bytes: Uint8Array,
  format: OfficeFormat,
  signal?: AbortSignal,
): Promise<void> {
  if (bytes.length > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
  if (isCompoundFile(bytes)) throw new OfficeError("encrypted");
  const zip = new ZipReader(new BoundedReader(bytes), {
    useWebWorkers: false,
    checkSignature: true,
    strictness: "strict",
    filenameValidation: "strict",
  });
  const names = new Set<string>();
  let count = 0;
  let total = 0;
  try {
    for await (const entry of zip.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (++count > MAX_ENTRIES) throw new OfficeError("tooLarge");
      if (entry.encrypted) throw new OfficeError("encrypted");
      if (
        names.has(entry.filename) ||
        entry.filename.includes("\\") ||
        entry.filename.split("/").some((part) => part === "..")
      )
        throw new OfficeError("invalid");
      names.add(entry.filename);
      total += entry.uncompressedSize;
      if (!Number.isSafeInteger(total) || total > MAX_OFFICE_CONTENT)
        throw new OfficeError("tooLarge");
      if (entry.directory) continue;
      let written = 0;
      const xml = entry.filename.endsWith(".xml") || entry.filename.endsWith(".rels");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let tail = "";
      await entry.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            signal?.throwIfAborted();
            written += chunk.length;
            if (written > entry.uncompressedSize || written > MAX_OFFICE_CONTENT)
              throw new OfficeError("tooLarge");
            if (xml) {
              const text = tail + decoder.decode(chunk, { stream: true });
              if (text.includes("\0") || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text))
                throw new OfficeError("invalid");
              tail = text.slice(-32);
            }
          },
        }),
        { checkSignature: true, ...(signal ? { signal } : {}) },
      );
      if (xml) decoder.decode();
      if (written !== entry.uncompressedSize) throw new OfficeError("invalid");
    }
    if (
      !names.has("[Content_Types].xml") ||
      !names.has(format === "docx" ? "word/document.xml" : "xl/workbook.xml")
    )
      throw new OfficeError("invalid");
  } catch (error) {
    if (error instanceof OfficeError || signal?.aborted) throw error;
    throw new OfficeError("invalid");
  } finally {
    await zip.close();
  }
}

export const xml = (value: string): string =>
  value.replace(
    /[<>&"']/g,
    (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!,
  );
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const relationships = "http://schemas.openxmlformats.org/package/2006/relationships";
const office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export async function writeOfficeParts(
  parts: Record<string, string | Uint8Array>,
): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 6 });
  let total = 0;
  for (const [name, value] of Object.entries(parts)) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    total += bytes.length;
    if (total > MAX_OFFICE_CONTENT) throw new OfficeError("tooLarge");
    await zip.add(
      name,
      typeof value === "string" ? new TextReader(value) : new Uint8ArrayReader(value),
      { lastModDate: new Date(2020, 0, 1) },
    );
  }
  const result = await zip.close();
  if (result.length > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
  return result;
}

export async function blankWorkbook(sheetName: string): Promise<Uint8Array> {
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  return writeOfficeParts({
    "[Content_Types].xml":
      declaration +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    "_rels/.rels":
      declaration +
      `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml":
      declaration +
      `<workbook xmlns="${ns}" xmlns:r="${office}"><bookViews><workbookView/></bookViews><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      declaration +
      `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${office}/styles" Target="styles.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml":
      declaration +
      `<worksheet xmlns="${ns}"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData/></worksheet>`,
    "xl/styles.xml":
      declaration +
      `<styleSheet xmlns="${ns}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  });
}

export async function wordDocument(
  body = "<w:p/>",
  extra: Record<string, string | Uint8Array> = {},
): Promise<Uint8Array> {
  return writeOfficeParts({
    "[Content_Types].xml":
      declaration +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      declaration +
      `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml":
      declaration +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${office}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
    ...extra,
  });
}
