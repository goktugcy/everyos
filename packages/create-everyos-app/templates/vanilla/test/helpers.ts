import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";

/** In EveryOS the app reads its texts from its package; in tests, from public/ (tests run at the project's root). */
export function serveLocales(): void {
  vi.stubGlobal("fetch", async (input: URL | RequestInfo) => {
    const name = String(input).split("/").pop()!;
    return new Response(await readFile(join(process.cwd(), "public", "locales", name)));
  });
}
