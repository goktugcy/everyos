import { ERROR_CODES, SUPPORTED_LOCALES } from "@otuken/shared";
import { describe, expect, it } from "vitest";
import { resources } from "./index.ts";

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

describe("translations", () => {
  const source = flatten(resources.tr);

  it("provides every supported locale", () => {
    expect(Object.keys(resources).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it.each(SUPPORTED_LOCALES)("%s has exactly the source keys and no empty strings", (locale) => {
    const messages = flatten(resources[locale]);
    expect([...messages.keys()].sort()).toEqual([...source.keys()].sort());
    for (const [key, value] of messages) expect(value.trim(), key).not.toBe("");
  });

  it.each(SUPPORTED_LOCALES)("%s keeps the same interpolation placeholders", (locale) => {
    const messages = flatten(resources[locale]);
    for (const [key, value] of source)
      expect(placeholders(messages.get(key)!), key).toEqual(placeholders(value));
  });

  it("localizes every API error code", () => {
    for (const code of ERROR_CODES) expect(resources.tr.errors[code]).toBeTruthy();
  });
});
