# Development guide

The desktop menu bar supports a right-click or Shift+F10 customization menu. Indicator
visibility, left-to-right order and clock seconds use the existing per-account preferences API.
The same editor is available under Settings → Desktop. Legacy documents without `order`
keep the original layout; partial orders append missing modules, and duplicate/unknown IDs
are rejected by the server. Reset restores only menu bar preferences. The brand/window menus,
user actions and connection information remain accessible.

The connection indicator is a text-only popover. HTTPS describes the browser-to-server hop;
HTTP remains unencrypted even on loopback or inside a possible VPN tunnel. The panel cannot
verify reverse-proxy backend encryption or VPN protection. It subscribes to API-client metadata
only while open, retains at most 12 completions in component memory, and clears on close, lock
or session change. Only method, a fixed resource category, status, duration and UTF-8 body sizes
are exposed. Raw paths, query strings, headers and payloads never enter diagnostics. File uploads
are included; direct downloads and persistent event/terminal streams are excluded. Body sizes
exclude compression, HTTP headers and TLS overhead; they are not packet captures. No diagnostic
API requests or host capture privileges are introduced.

## Requirements

- Node.js **26** (see `.node-version`)
- pnpm **12** (`packageManager` in `package.json`)
- macOS or Linux. On macOS, Linux-only capabilities (systemd, journald, /proc, …) are reported as
  unavailable; everything else works.

## Commands

```bash
pnpm install          # install dependencies (only esbuild may run install scripts)
pnpm dev              # agent + API + Vite with hot reload → http://127.0.0.1:5173
pnpm dev:apps         # rebuild/serve official apps for an already running development stack
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

API and browser fixtures use a 64 MiB free-space reserve in their disposable directories so
small real-file scenarios run on developer disks with limited free space. Tests that verify
insufficient-space rejection explicitly override that reserve. Production configuration keeps
its default 1 GiB reserve for files and backups.

The end-to-end stack uses disposable state under `tests/e2e/.state` and port 7480 by default
(`EVERYOS_E2E_PORT` overrides it); it does not reuse or stop a running development stack. Phase 2
coverage includes window drag/resize/snap and restoration, dock/context menus, folders, all seven
themes, virtual desktops, API-enforced locking across reloads, mobile transitions, and recovery
from failed preference loads. Desktop/mobile screenshots are written to the test output directory.

Phase 3/4 browser tests set `EVERYOS_AGENT_SIMULATE=1`: Docker lifecycle, Compose import/down/up,
volume deletion, logs, live stats and error recovery run against the in-memory simulator, never
the developer's containers. Socket-level Docker tests use temporary fake Unix-socket servers;
Compose tests mock execution and inspect the exact arguments and environment.

The browser tests also set `EVERYOS_DEV_FAKE_GOOGLE=1`, which starts an in-memory stand-in for
Google's OAuth and Drive endpoints inside a development API ([drive.md](drive.md)), and plug in the
simulator's USB stick by creating `<state dir>/disks/.simulated-usb-stick`
([disks.md](disks.md)). `pnpm dev` can use the same variable to try Google Drive without a Google
account.

`EVERYOS_E2E_HTTP_HOST=everyos.lan pnpm test:e2e foundation.spec.ts:9 plain-http.spec.ts` opens
EveryOS by a host name over plain HTTP (mapped to the test server), like people who open it by
the server's address. Such pages are not a secure context, so browser APIs like
`crypto.randomUUID` are missing; web code uses `randomId()` instead, and ESLint refuses
`crypto.randomUUID` there. CI runs this check after the main browser tests.

After signing in, open System from the dock for real host information, or Settings for appearance,
desktop/dock, account and security preferences. Files and folders on the desktop live in the
home's Desktop folder (inside EveryOS's data directory, not the host's home directories). Keyboard
shortcuts are listed in Settings → Desktop and Dock.

## Development mode

`pnpm dev` (see `scripts/dev.ts`) creates `./.dev/{data,run,secrets}` and starts:

| Process | Command                               | Notes                                                          |
| ------- | ------------------------------------- | -------------------------------------------------------------- |
| agent   | `node --watch apps/agent/src/main.ts` | socket `./.dev/run/agent.sock` (0600)                          |
| api     | `node --watch apps/api/src/main.ts`   | `127.0.0.1:7470`, database `./.dev/data/everyos.db`            |
| web     | `vite`                                | `127.0.0.1:5173`, proxies `/api` and `/app-runtime` to the API |

TypeScript runs directly through Node's type stripping, so there is no build step in the loop.
Code must therefore use erasable syntax only: no `enum`, `namespace` or constructor parameter
properties (enforced by `erasableSyntaxOnly`). Relative imports carry the `.ts` extension.

On the first start, the API prints the **setup token** (development only). It is also in
`./.dev/data/setup-token`. To start over, stop `pnpm dev` and delete `./.dev`.

Development mode never runs as root and never modifies the host.

### Official desktop apps during development

`pnpm dev` builds the 29 actual official apps, runs their acceptance tests, and verifies their
packages using the same `official-apps:check` pipeline as CI. It serves this snapshot on an
automatically allocated loopback port. Registry and publisher signing keys are ephemeral; only
the public registry anchor is written to `.dev/official-app-registry.json`. The development API
loads this generated anchor and performs its normal registry/package signature checks. Production
ignores the file and retains the pinned GitHub release registry. An explicit `EVERYOS_CONFIG`
official-registry setting takes precedence in either mode.

This makes local app-store sync work before the SDK's first production release has published
`official-apps.json`. These are working source builds with development signatures, not a public
release or simulated apps. The snapshot remains unchanged until rebuilt. Restart `pnpm dev` after
editing official-app sources, or run `pnpm dev:apps` beside an older development stack. When the
generated anchor changes, restart that stack's API to load it. An already running standalone helper
exits when the next `pnpm dev` instance takes over its anchor. State and build artifacts remain
under the ignored `.dev` directory; production signing credentials are never used.

The Vite proxy forwards `/app-runtime` as well as `/api` to the API. Installed app documents,
module scripts, translations and icons use these versioned runtime URLs; serving the desktop's
HTML fallback there prevents apps from starting and leaves their icons blank. Runtime responses
retain the API's content types, CORS headers and sandbox policy in development.

Docker uses real read-only data when the Unix socket exists; otherwise it uses labeled simulated
data. EveryOS never changes Docker group membership or socket permissions. Development refuses
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

### Official app resource observations

`EVERYOS_APP_MEASUREMENTS=1 pnpm test:e2e foundation.spec.ts:9 official-apps.spec.ts` retains
`official-app-measurements.json` in the all-app launch test's output directory. It measures real
launch-to-visible-content time, runtime response body bytes, JavaScript heap and a three-second
Chromium task-time sample for each of the 29 installed apps. These observations use the existing
disposable stack and all original launch assertions; they introduce no performance threshold.
CI retains the JSON separately on both Linux architectures before the plain-HTTP run resets the
output directory.

The report records hardware, browser and sampling method. When Chromium shares a renderer between
the opaque app frame and the desktop, CPU/heap values explicitly include both. The sequential
samples do not force garbage collection, so earlier apps can affect a later total heap reading.
Task time is not OS process CPU, heap is not resident memory, and install/API traffic is excluded
from the runtime byte count. Agent fixture data is simulated; the browser measurements are real.
The collection uses [Playwright CDP sessions](https://playwright.dev/docs/api/class-browsercontext#browser-context-new-cdp-session).

## Adding things

- **An API endpoint:** add the request schema to `packages/shared/src/schemas/api.ts` and the
  response type to `packages/shared/src/api-types.ts`. Write the route with `parseJsonBody` and
  `requirePermission`, add audit entries for security-relevant actions, then add integration tests
  and document the endpoint in `docs/api.md`.
- **An error code:** add it to `ERROR_CODES` and translate it in every locale. The i18n test fails
  otherwise.
- **UI text:** add the key to `packages/i18n/src/locales/tr.ts` first (Turkish is the source
  locale), then to every other locale file. The type checker reports missing keys and the i18n
  test checks placeholders and plural forms. The browser loads each language as its own chunk
  (`@everyos/i18n/client`); only English (the default) is bundled.
- **An agent operation:** see [contracts.md §5](contracts.md#5-implemented-contracts-phase-1).
- **A migration:** append `NNNN-name.ts` to `packages/database/src/migrations` and register it.
  Never edit a released migration.

## Troubleshooting

| Symptom                                    | Cause / fix                                                                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_PNPM_OTHER_PM_EXPECTED`               | A parent directory's `package.json` pins another package manager. Run pnpm inside this repository.                                                                          |
| UI shows "Agent unavailable"               | The agent is not running, or its key differs. Check the `agent` lines in `pnpm dev`.                                                                                        |
| `Database schema version … is newer`       | A newer build migrated `./.dev`. Delete `./.dev` or switch back to that version.                                                                                            |
| Port 5173/7470 in use                      | Another dev server is running; both ports are strict.                                                                                                                       |
| Vite reports `ECONNREFUSED 127.0.0.1:7470` | The API is not listening. Check the preceding `api` error. Early Phase 5 databases missing `app_jobs` are upgraded automatically by migration 5; keep existing `.dev` data. |
| Playwright says the browser is missing     | `pnpm exec playwright install --only-shell chromium`                                                                                                                        |
