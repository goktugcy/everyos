# Contributing to Otuken

Thank you for helping. Otuken manages real servers, so correctness and security come before speed.

## Before you start

- Read [AGENTS.md](AGENTS.md) for the ground rules and security invariants, and
  [docs/architecture.md](docs/architecture.md) for the structure.
- For anything larger than a small fix, open an issue first so we can agree on the approach.

## Workflow

1. Install Node.js 26 and pnpm 12, then run `pnpm install`.
2. Create a branch from `main`.
3. Make focused changes and add or update tests. Every bug fix needs a regression test.
4. Run `pnpm check`. For UI or flow changes, also run `pnpm build && pnpm test:e2e`.
5. Open a pull request describing **what** changed, **why**, and **how it was tested**.

## Commit messages

Write commit messages in English and in the imperative mood, with a concise subject (≤ 72
characters):

```
Add TOTP replay protection to the login flow
```

## Translations

Turkish (`packages/i18n/src/locales/tr.ts`) is the source locale. When you add a key, add it to
every locale; the type checker and the i18n test enforce this. Keep technical terms understandable
rather than translating them literally.

## Reporting security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
