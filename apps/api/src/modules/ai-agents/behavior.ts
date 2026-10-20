import { DEFAULT_LOCAL_BEHAVIOR, type LocalBehavior, type Locale } from "@everyos/shared";

/**
 * Instructions when the user wrote none. Small local models answer far more sensibly with a role,
 * an honesty rule and a language rule than with no system message at all.
 */
export const DEFAULT_INSTRUCTIONS =
  "You are a helpful and honest assistant. Answer clearly and to the point. If you are not sure about something, say so instead of guessing, and never invent facts, names or numbers.";
/** Each interface language by its English name, the language of the instructions themselves. */
const LANGUAGE_NAMES: Record<Locale, string> = {
  tr: "Turkish",
  en: "English",
  de: "German",
  es: "Spanish",
  fr: "French",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  zh: "Simplified Chinese",
};

function languageRule(language: LocalBehavior["language"]): string {
  return language === "auto"
    ? "Reply in the same language as the user's latest message."
    : `Always reply in ${LANGUAGE_NAMES[language]}, even if the user writes in another language.`;
}
const LENGTH: Record<LocalBehavior["length"], { tokens: number; hint: string }> = {
  short: { tokens: 300, hint: "Keep every answer short: a few sentences at most." },
  normal: { tokens: 1200, hint: "" },
  long: { tokens: 4000, hint: "Give thorough, detailed answers when they help." },
};
const MEMORY: Record<Exclude<LocalBehavior["memory"], "auto">, number> = {
  "2k": 2048,
  "4k": 4096,
  "8k": 8192,
  "16k": 16384,
};

/** The system message and sampling parameters a local chat sends with every request. */
export function localRequest(
  behavior: LocalBehavior | undefined,
  protocol: "openai" | "ollama",
): { system: string; parameters: Record<string, number> } {
  const settings = behavior ?? DEFAULT_LOCAL_BEHAVIOR;
  const length = LENGTH[settings.length];
  const system = [
    settings.instructions.trim() || DEFAULT_INSTRUCTIONS,
    length.hint,
    languageRule(settings.language),
  ]
    .filter(Boolean)
    .join("\n\n");
  // 0 → 0.1 (consistent) … 100 → 1.2 (creative).
  const temperature = Math.round((0.1 + (settings.creativity / 100) * 1.1) * 100) / 100;
  const parameters: Record<string, number> =
    protocol === "ollama"
      ? {
          temperature,
          num_predict: length.tokens,
          // 0 → 1.0 (off) … 100 → 1.3.
          repeat_penalty: Math.round((1 + settings.repetition * 0.003) * 1000) / 1000,
          ...(settings.memory === "auto" ? {} : { num_ctx: MEMORY[settings.memory] }),
        }
      : {
          temperature,
          max_tokens: length.tokens,
          frequency_penalty: Math.round(settings.repetition * 0.8) / 100,
        };
  return { system, parameters };
}
