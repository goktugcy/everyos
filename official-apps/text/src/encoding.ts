/*
 * Text encodings. Reading uses the browser's TextDecoder (strict UTF-8 first, so a file is never
 * silently misread when it is valid UTF-8). Writing supports UTF-8 (with or without a byte order
 * mark), UTF-16 LE/BE, and single-byte code pages, whose tables come from TextDecoder itself.
 * Multi-byte legacy encodings (Shift_JIS, EUC-KR, GB18030) can be read but not written.
 */

export type Encoding =
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "windows-1252"
  | "iso-8859-1"
  | "windows-1254"
  | "iso-8859-9"
  | "windows-1251"
  | "koi8-r"
  | "iso-8859-2"
  | "windows-1250"
  | "shift_jis"
  | "euc-kr"
  | "gb18030";

export const ENCODINGS: readonly Encoding[] = [
  "utf-8",
  "utf-16le",
  "utf-16be",
  "windows-1252",
  "iso-8859-1",
  "windows-1254",
  "iso-8859-9",
  "windows-1250",
  "iso-8859-2",
  "windows-1251",
  "koi8-r",
  "shift_jis",
  "euc-kr",
  "gb18030",
];

const MULTI_BYTE = new Set<Encoding>(["shift_jis", "euc-kr", "gb18030"]);

export function canWrite(encoding: Encoding): boolean {
  return !MULTI_BYTE.has(encoding);
}

export type LineEnding = "lf" | "crlf" | "cr";

export interface Decoded {
  text: string;
  encoding: Encoding;
  bom: boolean;
  eol: LineEnding;
}

export class BinaryFileError extends Error {
  constructor() {
    super("binary");
    this.name = "BinaryFileError";
  }
}

/** The legacy encoding to try when a file is not UTF-8, by the person's language. */
export function fallbackEncoding(locale: string): Encoding {
  const language = locale.slice(0, 2);
  return (
    (
      {
        tr: "windows-1254",
        ru: "windows-1251",
        ja: "shift_jis",
        ko: "euc-kr",
        zh: "gb18030",
        de: "windows-1252",
      } as Partial<Record<string, Encoding>>
    )[language] ?? "windows-1252"
  );
}

export function detectEol(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  if (crlf >= lf && crlf >= cr && crlf > 0) return "crlf";
  if (cr > lf) return "cr";
  return "lf";
}

/** The text with "\n" line endings (how the editor holds it). */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function applyEol(text: string, eol: LineEnding): string {
  return eol === "lf" ? text : text.replace(/\n/g, eol === "crlf" ? "\r\n" : "\r");
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  let zeros = 0;
  for (const byte of sample) if (byte === 0) zeros += 1;
  return zeros > 0;
}

/** Reads bytes as text: a byte order mark decides, else strict UTF-8, else `fallback`. */
export function decode(bytes: Uint8Array, fallback: Encoding, forced?: Encoding): Decoded {
  let encoding: Encoding;
  let bom = false;
  let body = bytes;
  if (forced) encoding = forced;
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf-8";
    bom = true;
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    bom = true;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    bom = true;
  } else {
    if (looksBinary(bytes)) throw new BinaryFileError();
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      encoding = "utf-8";
    } catch {
      encoding = fallback;
    }
  }
  if (forced) {
    const marks: Partial<Record<Encoding, number[]>> = {
      "utf-8": [0xef, 0xbb, 0xbf],
      "utf-16le": [0xff, 0xfe],
      "utf-16be": [0xfe, 0xff],
    };
    const mark = marks[forced];
    bom = !!mark && mark.every((byte, index) => bytes[index] === byte);
  }
  if (bom) body = bytes.subarray(encoding === "utf-8" ? 3 : 2);
  const raw = new TextDecoder(encoding).decode(body);
  return { text: normalizeEol(raw), encoding, bom, eol: detectEol(raw) };
}

const singleByteTables = new Map<Encoding, Map<string, number>>();

/** Character → byte for a single-byte code page, built from the browser's own decoder. */
function singleByteTable(encoding: Encoding): Map<string, number> {
  let table = singleByteTables.get(encoding);
  if (table) return table;
  table = new Map();
  const decoder = new TextDecoder(encoding);
  for (let byte = 0; byte < 256; byte += 1) {
    const char = decoder.decode(new Uint8Array([byte]));
    if (char !== "�" && !table.has(char)) table.set(char, byte);
  }
  singleByteTables.set(encoding, table);
  return table;
}

export class UnencodableError extends Error {
  readonly char: string;
  readonly line: number;

  constructor(char: string, line: number) {
    super("unencodable");
    this.name = "UnencodableError";
    this.char = char;
    this.line = line;
  }
}

/** Text → bytes; throws UnencodableError for the first character the encoding cannot hold. */
export function encode(
  text: string,
  encoding: Encoding,
  bom: boolean,
  eol: LineEnding,
): Uint8Array {
  const content = applyEol(text, eol);
  if (encoding === "utf-8") {
    const body = new TextEncoder().encode(content);
    if (!bom) return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    const offset = bom ? 2 : 0;
    const out = new Uint8Array(offset + content.length * 2);
    const view = new DataView(out.buffer);
    if (bom) view.setUint16(0, 0xfeff, encoding === "utf-16le");
    for (let index = 0; index < content.length; index += 1)
      view.setUint16(offset + index * 2, content.charCodeAt(index), encoding === "utf-16le");
    return out;
  }
  if (!canWrite(encoding)) throw new UnencodableError("", 0);
  const table = singleByteTable(encoding);
  const out = new Uint8Array(content.length);
  let length = 0;
  let line = 1;
  for (const char of content) {
    if (char === "\n") line += 1;
    const byte = char.charCodeAt(0) < 0x80 ? char.charCodeAt(0) : table.get(char);
    if (byte === undefined) throw new UnencodableError(char, line);
    out[length] = byte;
    length += 1;
  }
  return out.subarray(0, length);
}
