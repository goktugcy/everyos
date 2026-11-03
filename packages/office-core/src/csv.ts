import { read, utils, write } from "xlsx";
import { MAX_OFFICE_BYTES, OfficeError } from "./container.ts";

import { isCsvSettings, type CsvSettings } from "./csv-format.ts";

function delimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  let cells = 0;
  const finishField = () => {
    if (++cells > 250000 || row.length >= 16384) throw new OfficeError("tooLarge");
    row.push(field);
    field = "";
    closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += char;
    } else if (char === delimiter) finishField();
    else if (char === "\r" || char === "\n") {
      finishField();
      rows.push(row);
      row = [];
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else if (closed) throw new OfficeError("invalid");
    else if (char === '"') {
      if (field) throw new OfficeError("invalid");
      quoted = true;
    } else field += char;
    if (field.length > 32767) throw new OfficeError("tooLarge");
  }
  if (quoted) throw new OfficeError("invalid");
  if (field || closed || row.length || !rows.length) {
    finishField();
    rows.push(row);
  }
  return rows;
}

export function importCsv(bytes: Uint8Array, sheetName: string) {
  if (bytes.length > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  const bom = encoding !== "utf-8" || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new OfficeError("invalid");
  }
  if (text.includes("\0")) throw new OfficeError("invalid");
  const separator = /^sep=([,;\t])(?:\r\n|\n|\r)/i.exec(text);
  if (separator) text = text.slice(separator[0].length);
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  let newline: CsvSettings["newline"] = "\r\n";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (char === "\r" || char === "\n") {
        newline = char === "\r" && text[i + 1] === "\n" ? "\r\n" : char;
        break;
      }
      if (char === "," || char === ";" || char === "\t") counts[char]++;
    }
  }
  const delimiter = (separator?.[1] ??
    (Object.keys(counts) as Array<keyof typeof counts>).sort(
      (a, b) => counts[b] - counts[a],
    )[0]) as CsvSettings["delimiter"];
  const settings: CsvSettings = {
    delimiter,
    encoding,
    bom,
    newline,
    trailingNewline: /[\r\n]$/.test(text),
    separatorLine: !!separator,
  };
  const rows = delimitedRows(text, delimiter).map((row) =>
    row.map((value) => {
      // Preserve identifiers, long integers, dates and formula-looking text as text.
      if (
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) &&
        value.replace(/\D/g, "").length <= 15 &&
        Number.isFinite(Number(value))
      )
        return Number(value);
      return value;
    }),
  );
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet(rows), sheetName);
  const output = new Uint8Array(
    write(workbook, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer,
  );
  if (output.length > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
  return { bytes: output, settings };
}

export function exportCsv(bytes: Uint8Array, settings: CsvSettings) {
  if (!isCsvSettings(settings)) throw new OfficeError("invalid");
  const workbook = read(bytes, { type: "array", cellNF: true, cellFormula: true, bookVBA: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
  if (!sheet) throw new OfficeError("invalid");
  const range = utils.decode_range(sheet["!ref"] ?? "A1");
  if ((range.e.r + 1) * (range.e.c + 1) > 250000) throw new OfficeError("tooLarge");
  let text = utils.sheet_to_csv(sheet, {
    FS: settings.delimiter,
    RS: settings.newline,
    blankrows: true,
  });
  if (settings.trailingNewline) text += settings.newline;
  if (settings.separatorLine) text = "sep=" + settings.delimiter + settings.newline + text;
  let output: Uint8Array;
  if (settings.encoding === "utf-8")
    output = new TextEncoder().encode((settings.bom ? "\ufeff" : "") + text);
  else {
    if (text.length * 2 + 2 > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
    output = new Uint8Array(text.length * 2 + (settings.bom ? 2 : 0));
    const view = new DataView(output.buffer);
    let offset = 0;
    if (settings.bom) {
      view.setUint16(0, 0xfeff, settings.encoding === "utf-16le");
      offset = 2;
    }
    for (let i = 0; i < text.length; i++)
      view.setUint16(offset + i * 2, text.charCodeAt(i), settings.encoding === "utf-16le");
  }
  if (output.length > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
  return { bytes: output, sheets: workbook.SheetNames.length };
}
