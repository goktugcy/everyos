# Regex Tester

EveryOS's regular expression tester (`dev.everyos.regex`) for JavaScript expressions: live
matches, groups, flags, replacements and a plain-language explanation.

## What it does

- **Live matching** as you type the pattern, the flags or the text: matches are highlighted in
  the text and listed with their positions and their numbered and named groups (groups that did
  not take part are marked as such).
- **Flags** d, g, i, m, s, u, v and y (those your browser supports), each explained; u and v
  exclude each other.
- **Replace preview** with `$1`, `$<name>`, `$&`, `` $` ``, `$'` and `$$`, as
  `String.prototype.replace` does; copy the result.
- **Explanation** of the pattern, part by part and nested by group: anchors, classes, escapes,
  Unicode properties, groups and lookarounds, backreferences, alternation and quantifiers (greedy
  or lazy). Invalid patterns show the browser's own error.
- **Examples** (email, URL, IPv4, ISO date with named groups, hex colors, UUID, semantic versions,
  phone numbers, slugs, words in any script, repeated words, trailing whitespace) and **saved
  expressions**.
- **Protection.** Matching runs in a separate worker: an expression that runs longer than 1.5 s
  (catastrophic backtracking) is stopped and reported, and the window never freezes. Test texts
  are limited to 1,000,000 characters and the list to 10,000 matches.

## Permissions

| Capability        | Why                                        |
| ----------------- | ------------------------------------------ |
| `storage:app`     | The current expression and saved ones      |
| `clipboard:write` | Copying the expression and the replacement |

## Storage

| Key       | Value                                        |
| --------- | -------------------------------------------- |
| `current` | Pattern, flags, test text and replacement    |
| `saved`   | Up to 100 named expressions                  |
| `panel`   | The open tab (matches, explanation, replace) |

## Development

```bash
pnpm exec vitest run --project official-apps official-apps/regex
cd official-apps/regex && pnpm exec everyos-app validate
```
