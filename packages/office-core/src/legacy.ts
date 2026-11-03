import readDoc from "./vendor/legacy-doc/reader.cjs";
import { read, write } from "xlsx";
import { isCompoundFile, MAX_OFFICE_BYTES, OfficeError, wordDocument, xml } from "./container.ts";

type Data = Record<string, unknown>;
const record = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Legacy import is always a new modern copy: unsupported binary features never overwrite the source. */
export async function convertLegacyDoc(
  bytes: Uint8Array,
  labels: Record<string, string>,
): Promise<Uint8Array> {
  if (bytes.length > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
  if (!isCompoundFile(bytes)) throw new OfficeError("invalid");
  const raw: unknown = readDoc.model(bytes);
  const model = record(raw);
  if (!raw || !Array.isArray(model.body)) throw new OfficeError("conversion");
  const parts: Record<string, Uint8Array | string> = {};
  const rels: string[] = [];
  let textSize = 0;
  let paragraphs = 0;
  let imageId = 0;
  const runXml = (input: unknown): string => {
    const run = record(input);
    const image = record(run.image);
    if (
      image.bytes instanceof Uint8Array &&
      ["image/png", "image/jpeg"].includes(String(image.mime))
    ) {
      if (image.bytes.length > 8 * 1024 ** 2) throw new OfficeError("tooLarge");
      const id = ++imageId;
      const name = `image-${id}.${image.mime === "image/png" ? "png" : "jpg"}`;
      parts[`word/media/${name}`] = image.bytes;
      rels.push(`<Relationship Id="img${id}" Type="${R}/image" Target="media/${name}"/>`);
      const cx = Math.round(number(image.dxa, 3000, 1, 12000) * 635);
      const cy = Math.round(number(image.dya, 2000, 1, 16000) * 635);
      return `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="${xml(labels.image ?? "")}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="${R}" r:embed="img${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    }
    const text = typeof run.text === "string" ? run.text : "";
    textSize += text.length;
    if (textSize > 8 * 1024 ** 2) throw new OfficeError("tooLarge");
    const properties: string[] = [];
    for (const [key, tag] of [
      ["b", "b"],
      ["i", "i"],
      ["strike", "strike"],
    ] as const)
      if (run[key] === true) properties.push(`<w:${tag}/>`);
    if (run.u === true) properties.push('<w:u w:val="single"/>');
    if (typeof run.font === "string")
      properties.push(
        `<w:rFonts w:ascii="${xml(run.font.slice(0, 256))}" w:hAnsi="${xml(run.font.slice(0, 256))}"/>`,
      );
    if (typeof run.size === "number")
      properties.push(`<w:sz w:val="${Math.round(number(run.size, 12, 1, 400) * 2)}"/>`);
    if (typeof run.color === "number") {
      const value = run.color >>> 0;
      const hex = [value & 255, (value >>> 8) & 255, (value >>> 16) & 255]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
      properties.push(`<w:color w:val="${hex}"/>`);
    }
    const body = Array.from(text)
      .filter((char) => {
        const code = char.codePointAt(0)!;
        return (
          [9, 10, 12, 13].includes(code) ||
          (code >= 32 && (code <= 0xd7ff || (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000))
        );
      })
      .join("")
      .split(/(\t|\r?\n|\f)/)
      .map((part) =>
        part === "\t"
          ? "<w:tab/>"
          : part === "\f"
            ? '<w:br w:type="page"/>'
            : /^(?:\r?\n)$/.test(part)
              ? "<w:br/>"
              : `<w:t xml:space="preserve">${xml(part)}</w:t>`,
      )
      .join("");
    const content = `<w:r><w:rPr>${properties.join("")}</w:rPr>${body}</w:r>`;
    if (
      typeof run.url === "string" &&
      /^(https?:|mailto:)/i.test(run.url) &&
      run.url.length < 4096
    ) {
      const id = `link${rels.length + 1}`;
      rels.push(
        `<Relationship Id="${id}" Type="${R}/hyperlink" Target="${xml(run.url)}" TargetMode="External"/>`,
      );
      return `<w:hyperlink r:id="${id}">${content}</w:hyperlink>`;
    }
    return content;
  };
  const paragraph = (value: unknown): string => {
    if (++paragraphs > 30000) throw new OfficeError("tooLarge");
    const p = record(value);
    const runs = list(p.runs);
    if (runs.length > 100000) throw new OfficeError("tooLarge");
    const align = ["left", "center", "right", "both"][number(p.align, 0, 0, 3)] ?? "left";
    const marker = record(p.list).marker;
    return `<w:p><w:pPr><w:jc w:val="${align}"/></w:pPr>${typeof marker === "string" ? `<w:r><w:t xml:space="preserve">${xml(marker)} </w:t></w:r>` : ""}${runs.map(runXml).join("")}</w:p>`;
  };
  const story = (items: unknown[]): string => {
    const result: string[] = [];
    let cells: string[] = [];
    let rows: string[] = [];
    let columns = 0;
    const endRow = () => {
      if (cells.length) {
        columns = Math.max(columns, cells.length);
        rows.push(`<w:tr>${cells.join("")}</w:tr>`);
        cells = [];
      }
    };
    const endTable = () => {
      endRow();
      if (rows.length) {
        result.push(
          `<w:tbl><w:tblPr><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="4"/>`).join("")}</w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${Math.floor(9000 / columns)}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`,
        );
        rows = [];
        columns = 0;
      }
    };
    for (const item of items) {
      const p = record(item);
      if (p.kind === "cell" || p.kind === "rowEnd") {
        if (cells.length >= 100) throw new OfficeError("tooLarge");
        cells.push(`<w:tc><w:tcPr/>${paragraph(item)}</w:tc>`);
        if (p.kind === "rowEnd") endRow();
      } else {
        endTable();
        result.push(paragraph(item));
      }
    }
    endTable();
    return result.join("");
  };
  let body = story(model.body);
  for (const key of [
    "headers",
    "footnotes",
    "endnotes",
    "annotations",
    "textboxes",
    "headerTextboxes",
  ]) {
    const items = list(model[key]);
    if (!items.length) continue;
    body +=
      `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${xml(labels[key] ?? "")}</w:t></w:r></w:p>` +
      story(items);
  }
  if (rels.length)
    parts["word/_rels/document.xml.rels"] =
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
  return wordDocument(body, parts);
}

export function convertLegacyWorkbook(bytes: Uint8Array): Uint8Array {
  if (bytes.length > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
  if (!isCompoundFile(bytes)) throw new OfficeError("invalid");
  try {
    const workbook = read(bytes, {
      type: "array",
      cellStyles: true,
      cellFormula: true,
      cellNF: true,
      bookVBA: false,
    });
    if (!workbook.SheetNames.length || workbook.SheetNames.length > 100)
      throw new OfficeError("tooLarge");
    let cells = 0;
    for (const sheet of Object.values(workbook.Sheets)) {
      cells += Object.keys(sheet).filter((key) => !key.startsWith("!")).length;
      if (cells > 250000) throw new OfficeError("tooLarge");
    }
    const data: unknown = write(workbook, {
      bookType: "xlsx",
      type: "array",
      compression: true,
      cellStyles: true,
    });
    const output =
      data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
    if (!output || output.length > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
    return output;
  } catch (error) {
    if (error instanceof OfficeError) throw error;
    throw new OfficeError("conversion");
  }
}
