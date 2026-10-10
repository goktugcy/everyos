# AGENTS.md — working on Otuken

Instructions for AI coding agents and human contributors working in this repository.

## Communication language (mandatory)

- **Every message to the project owner is written in Turkish.** This covers questions, progress
  reports, explanations, warnings and summaries.
- Code, identifiers, file names, API routes, database schemas, commit messages, PR titles, code
  comments and developer documentation are written in **English**.
- User-facing UI text never appears as a literal in components. It comes from
  `packages/i18n` (Turkish is the source and default locale; English must stay complete).

## Ground rules

- Build real, working software. Never present mock data, a placeholder screen or a disconnected UI
  as a finished feature. Data that is genuinely simulated must be marked `source: "simulated"` and
  labeled in the UI.
- Never claim that tests passed without running them. Never fabricate benchmark numbers; measure
  them.
- Otuken never owns the host. Do not modify, stop or remove existing services, containers,
  volumes or images without an explicit, confirmed user action.
- Do not perform destructive operations on a real host without the owner's explicit approval.
- Ask only when a decision materially affects requirements, security, compatibility or irreversible
  behaviour. Otherwise make a sound engineering choice and document it in `docs/decisions.md` if it
  is non-obvious.

## Security invariants (do not break)

1. The web client never performs privileged work. The API runs unprivileged.
2. The agent only executes operations listed in `packages/agent-protocol/src/operations.ts`, each
   with zod-validated params and results, a permission, a timeout and policy checks. **Never add a
   generic command or shell operation.**
3. Every API route validates input with zod (`parseJsonBody`/`parseQuery`, strict objects) and
   checks a permission. Hiding a button is never authorization.
4. Security-relevant actions write an audit event, and audit details never contain secrets.
5. Secrets at rest go through `SecretBox` with a context string. Secrets are never sent to the
   browser unless the user must see them once (TOTP enrollment, recovery codes).
6. Remote catalog content is data: it is never executed or dynamically imported, and never rendered
   as HTML.
7. The browser bundle stays zod-free: import schemas only from `@otuken/shared/schemas` in server
   code.

## Code conventions

- TypeScript strict mode, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and
  **erasable syntax only** (no enums, namespaces or parameter properties). Node runs `.ts` directly.
- Relative imports include the `.ts`/`.tsx` extension.
- Small modules with explicit dependencies (constructor or factory injection), and no unnecessary
  abstraction layers.
- Logging uses `@otuken/logger` with structured fields. `console.*` is a lint error outside
  scripts and tests.
- Match the surrounding code's style and comment density. Comments explain _why_, not _what_.

## Commands

```bash
pnpm install && pnpm dev   # development stack (agent + API + Vite)
pnpm check                 # format check, lint, typecheck, unit/integration tests
pnpm build && pnpm test:e2e
```

## Definition of done

Implementation exists, works with real data, enforces permissions on the server, handles errors,
has passing tests, integrates with the rest of Otuken, shows the real state in the UI, and updates
the docs (`docs/`). Report incomplete parts explicitly.
