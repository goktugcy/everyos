/**
 * Launcher search. Matching is case- and diacritic-insensitive with Turkish
 * rules (İ/ı), so "ayarlar", "AYARLAR" and "ayarlar" typed without Turkish
 * characters all find the same entries.
 */
export interface SearchEntry {
  id: string;
  title: string;
  keywords?: readonly string[];
}

const FOLD: Record<string, string> = { ı: "i", ş: "s", ğ: "g", ü: "u", ö: "o", ç: "c" };

export function normalize(text: string): string {
  return text
    .toLocaleLowerCase("tr")
    .replace(/[ışğüöç]/g, (char) => FOLD[char] ?? char)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

export function scoreEntry(entry: SearchEntry, query: string): number {
  const q = normalize(query);
  if (!q) return 1;
  const title = normalize(entry.title);
  if (title === q) return 120;
  if (title.startsWith(q)) return 100;
  if (title.split(/[\s:./-]+/).some((word) => word.startsWith(q))) return 80;
  if (title.includes(q)) return 60;
  const keywords = (entry.keywords ?? []).map(normalize);
  if (keywords.some((keyword) => keyword.startsWith(q))) return 40;
  if (keywords.some((keyword) => keyword.includes(q))) return 20;
  return 0;
}

/** Entries matching `query`, best first; ties keep their original order. */
export function searchEntries<T extends SearchEntry>(
  entries: readonly T[],
  query: string,
  limit = 20,
): T[] {
  return entries
    .map((entry, index) => ({ entry, index, score: scoreEntry(entry, query) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((result) => result.entry);
}
