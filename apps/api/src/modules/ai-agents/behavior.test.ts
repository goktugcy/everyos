import { DEFAULT_LOCAL_BEHAVIOR, LOCAL_LANGUAGES, SUPPORTED_LOCALES } from "@everyos/shared";
import { describe, expect, it } from "vitest";
import { localRequest } from "./behavior.ts";

describe("local chat reply language", () => {
  it("offers every interface language", () => {
    expect(LOCAL_LANGUAGES).toEqual(["auto", ...SUPPORTED_LOCALES]);
  });

  it.each([
    ["auto", "Reply in the same language as the user's latest message."],
    ["de", "Always reply in German, even if the user writes in another language."],
    ["zh", "Always reply in Simplified Chinese, even if the user writes in another language."],
  ] as const)("%s ends the system message with its rule", (language, rule) => {
    const { system } = localRequest({ ...DEFAULT_LOCAL_BEHAVIOR, language }, "ollama");
    expect(system.endsWith(`\n\n${rule}`)).toBe(true);
  });
});
