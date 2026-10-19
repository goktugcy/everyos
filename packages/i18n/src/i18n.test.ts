import { ERROR_CODES, SUPPORTED_LOCALES } from "@everyos/shared";
import { describe, expect, it } from "vitest";
import { intlLocaleTag, resources } from "./index.ts";
import { loadMessages } from "./client.ts";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!).sort();
}

/** Plural forms beyond `_one`/`_other` that a language may add next to an `_other` key. */
const EXTRA_PLURAL = /^(.*)_(zero|two|few|many)$/;

// These are input values and file/configuration identifiers, not translatable prose.
const LITERAL_VALUES = [
  "EveryOS",
  "API_SERVER_ENABLED=true",
  "API_SERVER_KEY",
  "hermes-agent",
  "127.0.0.1",
  "/v1",
  "server.host",
  "server.publicOrigins",
  "server.trustedProxies",
  "files.roots",
  "/etc/everyos/config.yaml",
  "config.yaml",
  "secret.key",
  ".eosbak",
  "everyos-backup-",
  "upstream-base-url",
  "https://ntfy.sh",
  "apt-get update",
  "tailscale funnel reset",
  "tailscale up",
  "123456:ABC",
] as const;

describe("translations", () => {
  const source = flatten(resources.tr);
  const pluralBases = [...source.keys()]
    .filter((key) => key.endsWith("_other"))
    .map((key) => key.slice(0, -"_other".length));

  it("provides every supported locale", () => {
    expect(Object.keys(resources).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it.each(SUPPORTED_LOCALES)("loads the complete %s browser resource", async (locale) => {
    expect(await loadMessages[locale]()).toEqual(resources[locale]);
  });

  it.each(SUPPORTED_LOCALES)("%s has the source keys, no empty strings", (locale) => {
    const messages = flatten(resources[locale]);
    for (const key of source.keys()) expect(messages.has(key), key).toBe(true);
    for (const [key, value] of messages) {
      expect(value.trim(), key).not.toBe("");
      if (source.has(key)) continue;
      // Only plural forms of a pluralized key may be added.
      const base = EXTRA_PLURAL.exec(key)?.[1];
      expect(base !== undefined && source.has(`${base}_other`), `unexpected key ${key}`).toBe(true);
    }
  });

  it.each(SUPPORTED_LOCALES)("%s has every plural form its language uses", (locale) => {
    const messages = flatten(resources[locale]);
    const categories = new Intl.PluralRules(intlLocaleTag[locale]).resolvedOptions()
      .pluralCategories;
    for (const base of pluralBases)
      for (const category of categories)
        expect(messages.has(`${base}_${category}`), `${base}_${category}`).toBe(true);
  });

  it.each(SUPPORTED_LOCALES)("%s keeps the same interpolation placeholders", (locale) => {
    const messages = flatten(resources[locale]);
    for (const [key, value] of messages) {
      const base = EXTRA_PLURAL.exec(key)?.[1];
      // Every plural form keeps {{count}}: "one" also covers 21, 31… in Russian and 0 in French.
      const reference = source.get(key) ?? source.get(`${base}_other`)!;
      expect(placeholders(value), `${locale} ${key}`).toEqual(placeholders(reference));
    }
  });

  it("names every language in its own language, the same everywhere", () => {
    for (const locale of SUPPORTED_LOCALES)
      expect(resources[locale].languages, locale).toEqual(resources.tr.languages);
  });

  it.each(SUPPORTED_LOCALES)("%s preserves technical literals from the source", (locale) => {
    const messages = flatten(resources[locale]);
    for (const [key, original] of source) {
      for (const literal of LITERAL_VALUES) {
        if (original.includes(literal))
          expect(messages.get(key), `${locale} ${key}: ${literal}`).toContain(literal);
      }
    }
  });

  it("localizes every API error code", () => {
    for (const code of ERROR_CODES) expect(resources.tr.errors[code]).toBeTruthy();
  });
});
