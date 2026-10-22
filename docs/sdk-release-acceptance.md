# App SDK release acceptance

The App SDK, the unified store and the 33 official apps ship in **one** public release. This report
tracks every gate with its evidence (test names, CI runs, measured numbers). An item is checked only
when the implementation exists and the evidence is linked; until every item is checked, the
`feature/app-sdk` branch is not released.

Status: **in development** — see [App SDK architecture](app-sdk/architecture.md). Nothing below is
checked yet; the evidence column records what already passes, so the remaining work stays visible.

## Gates

| Gate                                                             | Status      | Evidence                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EveryOS core builds                                              | open        |                                                                                                                                                                                                                                                                                 |
| Existing Docker App Store still works                            | open        |                                                                                                                                                                                                                                                                                 |
| Desktop App Store works                                          | open        |                                                                                                                                                                                                                                                                                 |
| `create-everyos-app` creates a working app                       | in progress | `packages/app-cli/src/cli.test.ts`: all four templates build, validate, pack, typecheck and pass their own tests                                                                                                                                                                |
| `.eosapp` build and validation                                   | in progress | `packages/app-package/src/package.test.ts`                                                                                                                                                                                                                                      |
| Package signing and verification                                 | in progress | `package.test.ts`, `packages/app-registry/src/registry.test.ts`, `apps/api/src/desktop-apps.test.ts`                                                                                                                                                                            |
| Third-party apps run isolated (opaque-origin sandbox)            | in progress | `tests/e2e/sdk-desktop-apps.spec.ts` (Chromium, also over plain HTTP): no parent DOM, cookies, origin storage or API access                                                                                                                                                     |
| No unauthorized host access through documented capabilities      | open        |                                                                                                                                                                                                                                                                                 |
| All SDK permission checks enforced server-side                   | in progress | `desktop-apps.test.ts` › app SDK calls, app file access, notifications and host data, app network access, app databases (real PostgreSQL and MariaDB), app SSH keys (verified with ssh-keygen), app appearance; `sdk-desktop-apps.spec.ts` sets a wallpaper through the desktop |
| App install and removal                                          | in progress | `desktop-apps.test.ts` › installation; `sdk-desktop-apps.spec.ts` installs and uninstalls through the store                                                                                                                                                                     |
| App updates and compatibility checks                             | in progress | `desktop-apps.test.ts` › updates, revocations, incompatible SDK                                                                                                                                                                                                                 |
| All 33 official apps implemented with working primary features   | open        |                                                                                                                                                                                                                                                                                 |
| All 33 packages build, validate and are signed                   | open        |                                                                                                                                                                                                                                                                                 |
| All 33 apps pass their acceptance tests                          | open        |                                                                                                                                                                                                                                                                                 |
| All official apps appear in the store                            | open        |                                                                                                                                                                                                                                                                                 |
| App widgets integrate with the desktop                           | in progress | `sdk-desktop-apps.spec.ts` adds the probe's widget from the gallery (sandboxed, declared capabilities only); `widget-sdk.test.ts` › desktop app widgets                                                                                                                         |
| App settings and data persist                                    | open        |                                                                                                                                                                                                                                                                                 |
| Backup and restore compatibility                                 | in progress | `desktop-apps.test.ts` › desktop apps in backups (packages archived, restore staged and applied, re-verified, tampered package refused, repair)                                                                                                                                 |
| Mobile and desktop interfaces                                    | open        |                                                                                                                                                                                                                                                                                 |
| Localization validation (10 languages)                           | open        |                                                                                                                                                                                                                                                                                 |
| Developer CLI                                                    | in progress | `cli.test.ts` (build, validate, pack, dev server under the runtime CSP, own signed registry, revoke, refresh)                                                                                                                                                                   |
| Community registry (service + client)                            | open        |                                                                                                                                                                                                                                                                                 |
| Private registry support                                         | in progress | `desktop-apps.test.ts` › an independent developer's registry (create → publish → fingerprint → install)                                                                                                                                                                         |
| Documentation complete                                           | open        |                                                                                                                                                                                                                                                                                 |
| No existing EveryOS functionality broken (full regression suite) | open        |                                                                                                                                                                                                                                                                                 |
| ARM64 acceptance                                                 | open        |                                                                                                                                                                                                                                                                                 |
| AMD64 acceptance                                                 | open        |                                                                                                                                                                                                                                                                                 |
| Security regression tests                                        | in progress | network policy: `desktop-apps.test.ts` › app network access (scoping, DNS rebinding, metadata, redirects, no credentials)                                                                                                                                                       |
| CI green                                                         | open        |                                                                                                                                                                                                                                                                                 |
| Release artifacts verified                                       | open        |                                                                                                                                                                                                                                                                                 |
| Release candidate prepared                                       | open        |                                                                                                                                                                                                                                                                                 |

## Official apps

The official registry trust anchor is pinned to the GitHub release index and the owner's public
key (see [publishing](app-sdk/publishing.md)). `anchors.test.ts` verifies the URL, fingerprint
and absent community anchor; `packages/catalogs/src/fetch.test.ts` verifies GitHub's latest →
versioned release → object redirect with public DNS pinned at every hop, credentials dropped
across origins, and private/metadata/mapped-address redirects refused. These five focused tests
passed on 2026-10-22. Publication, the complete signed catalog and the community anchor remain open.

| #   | App              | Id                        | Status |
| --- | ---------------- | ------------------------- | ------ |
| 01  | Notes            | `dev.everyos.notes`       | open   |
| 02  | Markdown Editor  | `dev.everyos.markdown`    | open   |
| 03  | Calculator       | `dev.everyos.calculator`  | open   |
| 04  | Calendar         | `dev.everyos.calendar`    | open   |
| 05  | Pomodoro         | `dev.everyos.pomodoro`    | open   |
| 06  | To-Do            | `dev.everyos.todo`        | open   |
| 07  | PDF Viewer       | `dev.everyos.pdf`         | open   |
| 08  | Text Editor      | `dev.everyos.text`        | open   |
| 09  | Whiteboard       | `dev.everyos.whiteboard`  | open   |
| 10  | Code Editor      | `dev.everyos.code`        | open   |
| 11  | JSON Studio      | `dev.everyos.json`        | open   |
| 12  | API Client       | `dev.everyos.apiclient`   | open   |
| 13  | Regex Tester     | `dev.everyos.regex`       | open   |
| 14  | SQL Client       | `dev.everyos.sql`         | open   |
| 15  | Diff Viewer      | `dev.everyos.diff`        | open   |
| 16  | Cron Builder     | `dev.everyos.cron`        | open   |
| 17  | JWT Inspector    | `dev.everyos.jwt`         | open   |
| 18  | Color Studio     | `dev.everyos.color`       | open   |
| 19  | Port Inspector   | `dev.everyos.ports`       | open   |
| 20  | DNS Lookup       | `dev.everyos.dns`         | tested |
| 21  | SSL Inspector    | `dev.everyos.ssl`         | tested |
| 22  | HTTP Monitor     | `dev.everyos.httpmonitor` | tested |
| 23  | Log Viewer       | `dev.everyos.logs`        | open   |
| 24  | Disk Explorer    | `dev.everyos.disk`        | open   |
| 25  | SSH Keys         | `dev.everyos.sshkeys`     | open   |
| 26  | Network Tools    | `dev.everyos.network`     | open   |
| 27  | Uptime           | `dev.everyos.uptime`      | open   |
| 28  | Music Player     | `dev.everyos.music`       | open   |
| 29  | Video Player     | `dev.everyos.video`       | open   |
| 30  | Image Viewer     | `dev.everyos.images`      | open   |
| 31  | Gallery          | `dev.everyos.gallery`     | open   |
| 32  | Wallpaper Studio | `dev.everyos.wallpapers`  | open   |
| 33  | Icon Studio      | `dev.everyos.icons`       | open   |

## Measurements

Launch time, memory, CPU, network activity and package sizes are measured on the owner's Raspberry
Pi 5 and an amd64 runner once apps exist; nothing is estimated here.

## Development verification — 2026-10-22

- Baseline before new apps: format, lint, typecheck, 1,184 unit/integration tests, build and the
  nine foundation/official-app browser tests passed on the development Mac. This is not Linux
  acceptance or a release qualification.
- DNS Lookup: 25 logic tests and five interface tests pass (`official-apps/dns/test/`). The
  package validates with its declared elevated network permission. Its real-browser workflow in
  `official-apps.spec.ts` uses a loopback UDP DNS fixture: zero queries before policy approval,
  an actual A answer after approval, immediate-close history persistence, replay with the saved
  resolver port, and a mobile launch at 390 px without horizontal overflow.
- Shared kit: all network failure reasons, blocked-target guidance, IPv6 formatting, malformed
  error details and locale completeness pass in 12 tests (`network.test.ts`). The mock desktop
  preserves responder error details, covered by a separate regression test.
- CI already runs the complete browser suite on arm64 and amd64. Its additional plain-HTTP run
  now explicitly includes `official-apps.spec.ts` too; the hosted run remains to be verified.

“Tested” in the app table records development evidence, not public release approval. The remaining
apps, signed catalog pipeline, community service and its documentation, Linux measurements and
release evidence are still required. No tag or public release has been created.

### SSL and CI follow-up

- SSL Inspector: 27 logic tests and four interface tests pass. Its package validates. The
  Chromium workflow uses an actual self-signed local TLS service, checks trust and SNI identity
  separately, verifies the SHA-256 fingerprint and expiry warning, saves/reopens an endpoint,
  then verifies a genuine name mismatch. Its desktop layout was visually reviewed.
- The first pushed checkpoint passed the local full gate: 1,231 tests, build and ten browser
  tests. [CI run 105](https://github.com/goktugcy/everyos/actions/runs/39784658662) then exposed
  two Linux issues: Cron accepted edits before saved timezone hydration, and CLI template tests
  assumed a terminal-specific stdout summary. Cron now waits for stored state. The CLI test
  still runs each template's tests and now asserts the JSON report's success, positive passed
  count, zero failed tests and zero failed suites. No assertion of product behavior was removed;
  no tests were disabled. The focused checks pass under UTC and CI environment variables.
- Production dependency audit reported 15 advisories across pinned upstream dependencies.
  `markdown-it` is updated to 15.0.3; overrides select nanoid 3.3.18/5.1.16, lodash-es 4.18.1,
  KaTeX 0.18.2 and Sass 1.105.0 (whose watcher avoids the unpatched braces dependency).
  `pnpm audit --prod --json` reports zero advisories after the update. Install-script approval
  remains limited to esbuild; the optional Parcel watcher is explicitly denied. No release-age
  policy exception is used. The Excalidraw CDN-font patch is preserved.

The fresh local gate passed under UTC/CI settings: format, lint, typecheck, 1,263 tests, build,
11 Chromium tests and a clean production dependency audit. Both new apps were also visually
reviewed at mobile widths (DNS 390 px, SSL 360 px). Hosted CI verification is still required.

The [manifest reference](app-sdk/manifest.md) now documents every field and cross-field rule;
both JSON examples validate against the actual schema. The [SDK reference](app-sdk/sdk-reference.md)
contains the complete public instance and i18n signatures, all 28 typed host operations and their
capabilities, lifecycle/file/storage semantics, errors and links to the domain contracts. All
relative file links in these new reference pages resolve. Community-service documentation and
final distribution evidence remain open.

### Hosted CI portability follow-up

[CI run 106](https://github.com/goktugcy/everyos/actions/runs/39795217684) passed the production
security audit. Its arm64 job passed unit tests and the regular full browser suite, then reached
the job's 20-minute deadline during the extra plain-HTTP run. The job now has 35 minutes for both
browser passes. The extra pass runs after a successful build and browser installation, including
when the regular browser pass fails; it no longer attempts to start a missing build after an
earlier unit-test failure.

The amd64 run exposed a race in Code Editor's interface test: restored tabs and the folder
explorer finish independently. The exact expected tree assertion now waits for the asynchronous
folder read; no expected data or functionality was removed. The shared browser sign-in helper
also now makes authenticated requests from a same-origin browser document, because Chromium's
`everyos.lan` mapping does not apply to Node's APIRequestContext. Preference reset still unmounts
the desktop first, preventing restored window saves from racing the reset.

The corrected plain-HTTP command passed locally with `EVERYOS_E2E_HTTP_HOST=everyos.lan`: all
14 foundation, official-app, upload and SDK sandbox/network-policy browser tests passed. The
Code Editor logic/interface project also passed all 18 tests with the exact tree assertion retained.

### HTTP Monitor and hosted CI run 107

[CI run 107](https://github.com/goktugcy/everyos/actions/runs/39801994843) passed the dependency
audit and the entire arm64 job, including both browser passes. The amd64 job reached a Text
Editor interface-test race: its tab appears before the asynchronous editor mounts. The test now
waits for the exact decoded file content before editing; its encoding and line-ending assertions
remain intact. No test was skipped or relaxed.

HTTP Monitor uses the existing per-person, per-app server scheduler and network policy. Its
23 logic tests and six interface tests pass, covering strict form limits, incomplete draft
recovery, policy and locale changes, permission revocation, isolated endpoint histories,
100-row pagination and complete spreadsheet-safe CSV export. The package validates with all ten
locales. The browser workflow covers policy refusal, a real HTTP response, the unmodified
60-second background schedule with the window closed, down notifications, destination-picker
export, pause and reopening on mobile. All 1,292 unit/integration tests, the build and all 12
foundation/official-app Chromium tests passed before the following dependency update. The desktop
and 390 px mobile layouts were visually reviewed; the mobile layout has no horizontal overflow.

The final audit then reported three DOMPurify advisories (critical, high and low), all fixed in
[3.4.17](https://github.com/cure53/DOMPurify/releases/tag/3.4.17). The catalog and a scoped override
now select that version for both direct and transitive consumers; no advisory is ignored and
no supply-chain policy is relaxed. A fresh production audit reports zero advisories at every
severity. Full verification with the patched dependency passed under UTC/CI settings: format,
lint, typecheck, all 1,292 unit/integration tests, build, all 12 foundation/official-app Chromium
tests and the production audit. This remains development evidence; the complete 33-app release
and its remaining gates are still open.

The first-run and HTTP Monitor browser workflows also passed with
`EVERYOS_E2E_HTTP_HOST=everyos.lan` (two tests), including the background check, notification,
CSV picker and mobile reopening on an insecure LAN origin.

### Port Inspector

The app reads the existing bounded `system.sockets` operation: listening TCP/UDP addresses,
ports, readable process names and connection counters. It provides persistent search/protocol/
address-family/bind-scope filters, manual refresh, 100-row pagination and CSV export of every
matching row with source and UTC retrieval time. Bind scope does not assert firewall reachability.
Unsupported collectors and missing process names are explicit; simulated snapshots remain labelled
in both the interface and export. Revoking permission clears the displayed snapshot.

Eleven logic tests and six interface tests pass; the package validates in all ten locales.
The DOM test helper now recognizes the native `searchbox` role, with both its existing naming
test and the new native/explicit search-role test passing. No existing assertion was removed.
The two focused browser tests pass on macOS: they verify the unsupported-host message, persistence
and 390 px layout without inventing listeners. On Linux CI, the same workflow opens a real HTTP
fixture, finds its actual listening port through the agent, verifies the CSV through the file
picker and confirms that inspection made no connection to the fixture. Linux evidence is pending.
The full local gate passes under UTC/CI settings: format, lint, typecheck, 1,310 tests in 145
files, build, all 13 foundation/official-app Chromium tests and a clean production audit.
The first-run and Port Inspector browser workflows also pass over plain HTTP at `everyos.lan`
(two tests); this macOS run verifies honest unavailability, saved filters and mobile layout.
