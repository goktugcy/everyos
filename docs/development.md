# Development guide

## Requirements

- Node.js **26** (see `.node-version`)
- pnpm **12** (`packageManager` in `package.json`)
- macOS or Linux. On macOS, Linux-only capabilities (systemd, journald, /proc, …) are reported as
  unavailable; everything else works.

## Commands

```bash
pnpm install          # install dependencies (only esbuild may run install scripts)
pnpm dev              # agent + API + Vite with hot reload → http://127.0.0.1:5173
pnpm test             # unit + integration tests (Vitest)
pnpm typecheck        # tsc for every workspace package
pnpm lint             # ESLint (type-aware)
pnpm format           # Prettier
pnpm build            # web client + bundled API/agent into dist/
pnpm test:e2e         # Playwright against dist/ (run `pnpm build` first)
pnpm check            # format check + lint + typecheck + tests
```

The first `pnpm test:e2e` run on a machine needs the browser binary:
`pnpm exec playwright install --only-shell chromium`.

The end-to-end stack uses disposable state under `tests/e2e/.state` and port 7480 by default
(`OTUKEN_E2E_PORT` overrides it); it does not reuse or stop a running development stack. Phase 2
coverage includes window drag/resize/snap and restoration, dock/context menus, folders, all seven
themes, virtual desktops, API-enforced locking across reloads, mobile transitions, and recovery
from failed preference loads. Desktop/mobile screenshots are written to the test output directory.

Phase 3/4 browser tests set `OTUKEN_AGENT_SIMULATE=1`: Docker lifecycle, Compose import/down/up,
volume deletion, logs, live stats and error recovery run against the in-memory simulator, never
the developer's containers. Socket-level Docker tests use temporary fake Unix-socket servers;
Compose tests mock execution and inspect the exact arguments and environment.

After signing in, open System from the dock for real host information, or Settings for appearance,
desktop/dock, account and security preferences. Folder icons organize application shortcuts;
they do not operate on host files. Keyboard shortcuts are listed in Settings → Desktop and Dock.

## Development mode

`pnpm dev` (see `scripts/dev.ts`) creates `./.dev/{data,run,secrets}` and starts:

| Process | Command                               | Notes                                              |
| ------- | ------------------------------------- | -------------------------------------------------- |
| agent   | `node --watch apps/agent/src/main.ts` | socket `./.dev/run/agent.sock` (0600)              |
| api     | `node --watch apps/api/src/main.ts`   | `127.0.0.1:7470`, database `./.dev/data/otuken.db` |
| web     | `vite`                                | `127.0.0.1:5173`, proxies `/api` to the API        |

TypeScript runs directly through Node's type stripping, so there is no build step in the loop.
Code must therefore use erasable syntax only: no `enum`, `namespace` or constructor parameter
properties (enforced by `erasableSyntaxOnly`). Relative imports carry the `.ts` extension.

On the first start, the API prints the **setup token** (development only). It is also in
`./.dev/data/setup-token`. To start over, stop `pnpm dev` and delete `./.dev`.

Development mode never runs as root and never modifies the host.

Docker uses real read-only data when the Unix socket exists; otherwise it uses labeled simulated
data. Otuken never changes Docker group membership or socket permissions. Development refuses
mutations even when the account can access Docker. See [configuration.md](configuration.md) for
custom sockets/protected containers and [docker-management.md](docker-management.md) for host
verification limits.

## Tests

| Layer       | Location                                                                   | What it covers                                                                            |
| ----------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Unit        | `packages/*/src/*.test.ts`                                                 | crypto, password hashing, TOTP vectors, logger, migrations, framing, parsers, i18n parity |
| Integration | `apps/api/src/app.test.ts`, `packages/agent-protocol/src/protocol.test.ts` | full HTTP stack with a real SQLite database; real Unix-socket agent connections           |
| End-to-end  | `tests/e2e/*.spec.ts`                                                      | the built product in Chromium: setup, login, language switch, session persistence, CSRF   |

API tests use `apps/api/src/test-support.ts`. It provides a temporary database, a fake agent, a
controllable clock, cheap scrypt parameters, and a cookie-aware `TestClient` that behaves like a
browser (Origin header, CSRF token).

## Adding things

- **An API endpoint:** add the request schema to `packages/shared/src/schemas/api.ts` and the
  response type to `packages/shared/src/api-types.ts`. Write the route with `parseJsonBody` and
  `requirePermission`, add audit entries for security-relevant actions, then add integration tests
  and document the endpoint in `docs/api.md`.
- **An error code:** add it to `ERROR_CODES` and translate it in every locale. The i18n test fails
  otherwise.
- **UI text:** add the key to `packages/i18n/src/locales/tr.ts` first (Turkish is the source
  locale), then to `en.ts`. The type checker reports missing keys.
- **An agent operation:** see [contracts.md §5](contracts.md#5-implemented-contracts-phase-1).
- **A migration:** append `NNNN-name.ts` to `packages/database/src/migrations` and register it.
  Never edit a released migration.

## Troubleshooting

| Symptom                                | Cause / fix                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ERR_PNPM_OTHER_PM_EXPECTED`           | A parent directory's `package.json` pins another package manager. Run pnpm inside this repository. |
| UI shows "Agent unavailable"           | The agent is not running, or its key differs. Check the `agent` lines in `pnpm dev`.               |
| `Database schema version … is newer`   | A newer build migrated `./.dev`. Delete `./.dev` or switch back to that version.                   |
| Port 5173/7470 in use                  | Another dev server is running; both ports are strict.                                              |
| Playwright says the browser is missing | `pnpm exec playwright install --only-shell chromium`                                               |
