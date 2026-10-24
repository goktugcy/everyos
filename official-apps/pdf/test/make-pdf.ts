/**
 * A small, valid PDF for tests: pages of text in Helvetica (one line each entry) and an outline.
 * Written by hand so tests do not depend on a PDF writer.
 */
export function makePdf({
  pages,
  outline = [],
}: {
  pages: string[][];
  outline?: Array<{ title: string; page: number }>;
}): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) - 1 + 1;
  const escape = (text: string) => text.replace(/[\\()]/g, (char) => `\\${char}`);

  const catalog = add("");
  const pagesId = add("");
  const font = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const pageIds: number[] = [];
  for (const lines of pages) {
    const text = lines
      .map((line, index) => `BT /F1 20 Tf 72 ${720 - index * 32} Td (${escape(line)}) Tj ET`)
      .join("\n");
    const content = add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let outlines = "";
  if (outline.length) {
    const root = add("");
    const first = objects.length + 1;
    const ids = outline.map((_, index) => first + index);
    outline.forEach((item, index) => {
      const links = [
        index > 0 ? `/Prev ${ids[index - 1]} 0 R` : "",
        index < ids.length - 1 ? `/Next ${ids[index + 1]} 0 R` : "",
      ].join(" ");
      add(
        `<< /Title (${escape(item.title)}) /Parent ${root} 0 R ${links} /Dest [${pageIds[item.page - 1]} 0 R /Fit] >>`,
      );
    });
    objects[root - 1] =
      `<< /Type /Outlines /First ${ids[0]} 0 R /Last ${ids.at(-1)} 0 R /Count ${ids.length} >>`;
    outlines = ` /Outlines ${root} 0 R /PageMode /UseOutlines`;
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${outlines} >>`;

  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Only ASCII is written, so characters and bytes match the offsets above.
  return new TextEncoder().encode(out);
}
