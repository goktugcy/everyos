import { describe, expect, it } from "vitest";
import {
  applyEol,
  BinaryFileError,
  decode,
  detectEol,
  encode,
  fallbackEncoding,
  UnencodableError,
} from "../src/encoding.ts";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("decoding", () => {
  it("prefers byte order marks, then strict UTF-8, then the language's legacy encoding", () => {
    expect(decode(bytes(0xef, 0xbb, 0xbf, 0x68, 0x69), "windows-1252")).toMatchObject({
      text: "hi",
      encoding: "utf-8",
      bom: true,
    });
    expect(decode(new TextEncoder().encode("şğü"), "windows-1254")).toMatchObject({
      text: "şğü",
      encoding: "utf-8",
      bom: false,
    });
    // "şğ" in Windows-1254 is not valid UTF-8.
    expect(decode(bytes(0xfe, 0xf0), fallbackEncoding("tr"))).toMatchObject({
      text: "şğ",
      encoding: "windows-1254",
    });
    expect(decode(bytes(0xff, 0xfe, 0x3d, 0xd8, 0x00, 0xde), "utf-8")).toMatchObject({
      text: "😀",
      encoding: "utf-16le",
    });
    expect(decode(bytes(0xfe, 0xff, 0x00, 0x41), "utf-8").text).toBe("A");
    expect(() => decode(bytes(0x50, 0x4b, 0x00, 0x00, 0x03), "utf-8")).toThrow(BinaryFileError);
  });

  it("reads Shift_JIS, EUC-KR and GB18030 when chosen", () => {
    expect(decode(bytes(0x82, 0xa0), "utf-8", "shift_jis").text).toBe("あ");
    expect(fallbackEncoding("ko")).toBe("euc-kr");
    expect(fallbackEncoding("en")).toBe("windows-1252");
  });

  it("detects and keeps line endings", () => {
    const decoded = decode(new TextEncoder().encode("a\r\nb\r\nc"), "utf-8");
    expect(decoded).toMatchObject({ text: "a\nb\nc", eol: "crlf" });
    expect(detectEol("a\rb\rc")).toBe("cr");
    expect(detectEol("one line")).toBe("lf");
    expect(applyEol("a\nb", "crlf")).toBe("a\r\nb");
  });
});

describe("encoding", () => {
  it("round-trips every writable encoding", () => {
    const samples: Array<[string, Parameters<typeof encode>[1]]> = [
      ["Grüße, 😀 — ok", "utf-8"],
      ["Grüße, 😀 — ok", "utf-16le"],
      ["Grüße, 😀 — ok", "utf-16be"],
      ["İstanbul’da ılık şğüçöı", "windows-1254"],
      ["İstanbul ılık şğüçöı", "iso-8859-9"],
      ["Привет, мир", "windows-1251"],
      ["Привет, мир", "koi8-r"],
      ["Café € naïve", "windows-1252"],
      ["Zażółć gęślą", "windows-1250"],
    ];
    for (const [text, encoding] of samples)
      for (const bom of encoding.startsWith("utf") ? [false, true] : [false]) {
        const written = encode(`${text}\nline 2`, encoding, bom, "crlf");
        const read = decode(written, "windows-1252", encoding);
        expect(read).toMatchObject({ text: `${text}\nline 2`, encoding, bom, eol: "crlf" });
      }
  });

  it("refuses characters an encoding cannot hold, saying where", () => {
    try {
      encode("ok\nbut 😀 here", "windows-1252", false, "lf");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(UnencodableError);
      expect(error).toMatchObject({ char: "😀", line: 2 });
    }
    expect(() => encode("あ", "shift_jis", false, "lf")).toThrow(UnencodableError);
  });
});
