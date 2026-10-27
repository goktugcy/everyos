import { describe, expect, it } from "vitest";
import {
  addRecent,
  docKey,
  MAX_RECENT,
  nextRotation,
  parsePage,
  removeBookmark,
  sanitizeDocState,
  setBookmark,
  type Recent,
} from "../src/library.ts";
import { makePdf } from "./make-pdf.ts";

describe("pages and rotation", () => {
  it("reads typed page numbers within the document", () => {
    expect(parsePage(" 3 ", 10)).toBe(3);
    expect(parsePage("10", 10)).toBe(10);
    for (const text of ["0", "11", "2.5", "-1", "", "abc", "1e1"])
      expect(parsePage(text, 10), text).toBeNull();
  });

  it("turns a quarter at a time, both ways", () => {
    expect(nextRotation(0, 1)).toBe(90);
    expect(nextRotation(270, 1)).toBe(0);
    expect(nextRotation(0, -1)).toBe(270);
  });
});

describe("what is remembered per document", () => {
  it("keeps valid state and drops the rest", () => {
    expect(sanitizeDocState(null)).toEqual({ page: 1, zoom: "auto", rotation: 0, bookmarks: [] });
    expect(
      sanitizeDocState({
        page: 4,
        zoom: 1.5,
        rotation: 180,
        bookmarks: [{ page: 2, label: "Intro", createdAt: 1 }, { page: -1, label: "x" }, "bad"],
      }),
    ).toEqual({
      page: 4,
      zoom: 1.5,
      rotation: 180,
      bookmarks: [{ page: 2, label: "Intro", createdAt: 1 }],
    });
    expect(sanitizeDocState({ page: 0, zoom: "huge", rotation: 45 })).toMatchObject({
      page: 1,
      zoom: "auto",
      rotation: 0,
    });
    expect(sanitizeDocState({ zoom: "page-fit" }).zoom).toBe("page-fit");
    expect(sanitizeDocState({ zoom: 40 }).zoom).toBe("auto");
  });

  it("keeps one bookmark per page, in page order", () => {
    let list = setBookmark([], { page: 5, label: "Five", createdAt: 1 });
    list = setBookmark(list, { page: 2, label: "  Two  ", createdAt: 2 });
    list = setBookmark(list, { page: 5, label: "Summary", createdAt: 3 });
    expect(list.map((bookmark) => [bookmark.page, bookmark.label])).toEqual([
      [2, "Two"],
      [5, "Summary"],
    ]);
    expect(removeBookmark(list, 2).map((bookmark) => bookmark.page)).toEqual([5]);
  });

  it("lists recent documents newest first, once each", () => {
    const entry = (handleId: string, fingerprint: string): Recent => ({
      handleId,
      name: `${handleId}.pdf`,
      fingerprint,
      openedAt: 0,
    });
    let list = addRecent([], entry("a", "1"));
    list = addRecent(list, entry("b", "2"));
    // The same document from another file replaces its older entry.
    list = addRecent(list, entry("c", "1"));
    expect(list.map((item) => item.handleId)).toEqual(["c", "b"]);
    for (let index = 0; index < 20; index += 1)
      list = addRecent(list, entry(`x${index}`, `f${index}`));
    expect(list).toHaveLength(MAX_RECENT);
    expect(docKey("ab12cd/../x")).toBe("doc/ab12cdx");
  });
});

describe("the test PDF", () => {
  it("is a well-formed file with a cross-reference table", () => {
    const text = new TextDecoder().decode(
      makePdf({ pages: [["A"], ["B"]], outline: [{ title: "B", page: 2 }] }),
    );
    expect(text.startsWith("%PDF-1.7\n")).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...text.matchAll(/(\d{10}) 00000 n \n/g)].map((match) => Number(match[1]));
    expect(offsets.length).toBeGreaterThan(0);
    offsets.forEach((offset, index) =>
      expect(text.slice(offset).startsWith(`${index + 1} 0 obj\n`)).toBe(true),
    );
  });
});
