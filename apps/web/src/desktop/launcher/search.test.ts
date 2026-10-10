import { describe, expect, it } from "vitest";
import { normalize, scoreEntry, searchEntries } from "./search.ts";

const entries = [
  { id: "settings", title: "Ayarlar", keywords: ["settings", "tema", "görünüm"] },
  { id: "users", title: "Kullanıcılar", keywords: ["users", "hesaplar"] },
  { id: "audit", title: "Denetim Kaydı", keywords: ["audit", "log"] },
  { id: "lock", title: "Oturumu kilitle", keywords: ["lock"] },
];

describe("launcher search", () => {
  it("folds Turkish characters and case", () => {
    expect(normalize("KULLANICILAR")).toBe("kullanicilar");
    expect(normalize("İstanbul ŞÇĞÜÖ")).toBe("istanbul scguo");
    expect(normalize("  Görünüm ")).toBe("gorunum");
  });

  it("finds entries regardless of Turkish characters", () => {
    expect(searchEntries(entries, "kullanici").map((e) => e.id)).toEqual(["users"]);
    expect(searchEntries(entries, "kaydi").map((e) => e.id)).toEqual(["audit"]);
    expect(searchEntries(entries, "gorunum").map((e) => e.id)).toEqual(["settings"]);
  });

  it("ranks title prefixes above word prefixes above keywords", () => {
    const ranked = [
      { id: "kw", title: "Zeta", keywords: ["ayar"] },
      { id: "word", title: "Sistem ayarları" },
      { id: "prefix", title: "Ayarlar" },
    ];
    expect(searchEntries(ranked, "ayar").map((e) => e.id)).toEqual(["prefix", "word", "kw"]);
    expect(scoreEntry({ id: "x", title: "Ayarlar" }, "zzz")).toBe(0);
  });

  it("returns everything in order for an empty query", () => {
    expect(searchEntries(entries, "").map((e) => e.id)).toEqual([
      "settings",
      "users",
      "audit",
      "lock",
    ]);
  });
});
