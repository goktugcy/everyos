/** Ready-made patterns (names and descriptions are translated: examples.<id>). */
export interface Example {
  id: string;
  pattern: string;
  flags: string;
  text: string;
}

export const EXAMPLES: readonly Example[] = [
  {
    id: "email",
    pattern: String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`,
    flags: "gi",
    text: "Write to ada@example.com or grace.hopper+navy@mail.example.org, not to @nowhere.",
  },
  {
    id: "url",
    pattern: String.raw`https?:\/\/[^\s/$.?#][^\s]*`,
    flags: "gi",
    text: "Docs at https://everyos.dev/docs and http://192.168.1.10:8080/status?x=1 — not ftp://old.",
  },
  {
    id: "ipv4",
    pattern: String.raw`\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b`,
    flags: "g",
    text: "Router 192.168.1.1, DNS 1.1.1.1, invalid 256.1.1.1 and 10.0.0.300.",
  },
  {
    id: "isoDate",
    pattern: String.raw`(?<year>\d{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12]\d|3[01])`,
    flags: "g",
    text: "Released 2026-10-21, planned 2026-13-01 (invalid), backup 2025-02-28.",
  },
  {
    id: "hexColor",
    pattern: String.raw`#(?:[0-9a-fA-F]{3}){1,2}\b`,
    flags: "g",
    text: "Accent #0284c7, white #fff, not a color #12345 or #ggg.",
  },
  {
    id: "uuid",
    pattern: String.raw`\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b`,
    flags: "gi",
    text: "Session 1b4e28ba-2fa1-41d2-883f-0016d3cca427 expired.",
  },
  {
    id: "semver",
    pattern: String.raw`\bv?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?(?:\+([\w.-]+))?\b`,
    flags: "g",
    text: "Upgrade from v0.1.36 to 1.0.0-rc.1+build.5.",
  },
  {
    id: "phone",
    pattern: String.raw`\+?\d[\d\s().-]{7,}\d`,
    flags: "g",
    text: "Call +90 212 555 01 23 or (555) 123-4567.",
  },
  {
    id: "slug",
    pattern: String.raw`^[a-z0-9]+(?:-[a-z0-9]+)*$`,
    flags: "gm",
    text: "my-first-post\nNot A Slug\nversion-2",
  },
  {
    id: "words",
    pattern: String.raw`\p{L}+`,
    flags: "gu",
    text: "Grüße, İstanbul, 東京 and Москва.",
  },
  {
    id: "duplicateWords",
    pattern: String.raw`\b(\w+)\s+\1\b`,
    flags: "gi",
    text: "This is is a test of the the repeated words.",
  },
  {
    id: "trailingSpace",
    pattern: String.raw`[ \t]+$`,
    flags: "gm",
    text: "clean line\nline with spaces   \nanother\t\n",
  },
];

/** Flags in the order RegExp writes them, with what each changes (flags.<letter>). */
export const FLAGS = ["d", "g", "i", "m", "s", "u", "v", "y"] as const;

export function supportedFlags(): string[] {
  return FLAGS.filter((flag) => {
    try {
      new RegExp("", flag);
      return true;
    } catch {
      return false;
    }
  });
}
