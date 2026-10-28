# App SDK release acceptance

The App SDK, the unified store and the 29 official apps ship in **one** public release. This report
tracks every gate with its evidence (test names, CI runs, measured numbers). An item is checked only
when the implementation exists and the evidence is linked; until every item is checked, the
`feature/app-sdk` branch is not released.

This is the **pre-publication qualification record for 0.1.37**. The 29-app implementation and regression gate
pass. The production community service is deployed, and ordinary default-resolver inspection passes
production health, identity, public-key and signed-catalog verification. Temporary physical Pi core
measurements and native Linux app observations are recorded. The real human-reviewed production
community lifecycle passes and its public trust anchor is pinned. Final artifact signing and
publication run in the tag-restricted protected release environment. Current publication state and signed
assets are recorded on the [0.1.37 release](https://github.com/goktugcy/everyos/releases/tag/v0.1.37).
See [App SDK architecture](app-sdk/architecture.md).

`dev passed` means the linked development checks ran successfully; it does not imply production
signing, publication or approval. The dated sections below preserve prior failures and checkpoint
limitations. The latest checkpoint is authoritative when an older section lists subsequently
completed work as pending.

## Gates

| Gate                                                             | Status                         | Evidence                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EveryOS core builds                                              | dev passed                     | Full `pnpm build`; both real `.deb` packages contain 392 runtime/package files.                                                                                                                                                                        |
| Existing Docker App Store still works                            | dev passed                     | Full browser run including `zz-store.spec.ts` and `system-docker.spec.ts`; Store polling fallback regression.                                                                                                                                          |
| Desktop App Store works                                          | dev passed                     | `sdk-desktop-apps.spec.ts` installs, scopes permissions, persists data and removes apps through the store.                                                                                                                                             |
| `create-everyos-app` creates a working app                       | dev passed                     | All four [standalone templates](app-sdk/distribution.md) install, typecheck, test, pack, publish and run outside the workspace.                                                                                                                        |
| `.eosapp` build and validation                                   | dev passed                     | `packages/app-package/src/package.test.ts`; all 29 actual artifacts independently verified by `scripts/official-apps.ts`.                                                                                                                              |
| Package signing and verification                                 | dev passed; production pending | Package/registry/API security tests and ephemeral signed artifacts; production keys are used only by the protected release workflow.                                                                                                                   |
| Third-party apps run isolated (opaque-origin sandbox)            | dev passed                     | `sdk-desktop-apps.spec.ts` on normal and plain HTTP: no parent DOM, cookies, origin storage or direct API access.                                                                                                                                      |
| No unauthorized host access through documented capabilities      | dev passed                     | `desktop-apps.test.ts` denies undeclared grants, revoked instances, file/network/database/SSH/appearance scope violations.                                                                                                                             |
| All SDK permission checks enforced server-side                   | dev passed                     | API tests use real PostgreSQL and MariaDB fixtures and `ssh-keygen`; browser tests exercise native approval and rejection.                                                                                                                             |
| App install and removal                                          | dev passed                     | API installation tests and real store workflow.                                                                                                                                                                                                        |
| App updates and compatibility checks                             | dev passed                     | API update, immutable-version, revoked and incompatible-SDK tests; packaged Linux lifecycle.                                                                                                                                                           |
| All 29 official apps implemented with working primary features   | dev passed                     | `official-apps/*/test/`, 447 app assertions; real browser workflows detailed below.                                                                                                                                                                    |
| All 29 packages build, validate and are signed                   | dev passed; production pending | Complete ephemeral-key artifact pipeline; protected production signing remains a release step.                                                                                                                                                         |
| All 29 apps pass their acceptance tests                          | dev passed                     | Exact positive per-app test counts enforced by `scripts/official-apps.ts` and retained in its CI artifact report.                                                                                                                                      |
| All official apps appear in the store                            | dev passed                     | `official-apps.spec.ts` installs and launches every one of the 29 signed development packages.                                                                                                                                                         |
| App widgets integrate with the desktop                           | dev passed                     | Sandboxed widget gallery, Notes/Uptime browser workflows and `widget-sdk.test.ts`.                                                                                                                                                                     |
| App settings and data persist                                    | dev passed                     | API storage isolation, reload/reopen browser workflows and packaged Linux app-update/restore scenarios.                                                                                                                                                |
| Backup and restore compatibility                                 | dev passed                     | API archive/tamper/repair tests; real packaged authenticated backup, CLI restore and supervised restart.                                                                                                                                               |
| Mobile and desktop interfaces                                    | dev passed                     | Actual Chromium desktop/mobile workflows and reviewed screenshots described per app below.                                                                                                                                                             |
| Localization validation (10 languages)                           | dev passed                     | Every package's ten dictionaries validate; all 29 manifests default to `en`.                                                                                                                                                                           |
| Developer CLI                                                    | dev passed                     | CLI unit/integration tests and actual installed-archive acceptance, including runtime CSP and signed registry operations.                                                                                                                              |
| Community registry (service + client)                            | live passed                    | Fifteen actual workerd/D1/R2 integration tests; [ordinary production verification](evidence/community-20261026/deployment-verification.json). The public-key pin and [six-step live round trip](evidence/community-20261027/live-lifecycle.json) pass. |
| Private registry support                                         | dev passed                     | Independent developer registry API test plus standalone create/publish/refresh/revoke acceptance.                                                                                                                                                      |
| Documentation complete                                           | integration passed             | SDK references and [production identity/DNS evidence](evidence/community-20261026/dns-migration.json) and [human lifecycle evidence](evidence/community-20261027/live-lifecycle.json) are retained.                                                    |
| No existing EveryOS functionality broken (full regression suite) | dev passed; one hosted flake   | CI 125: format/lint/types, 1,529 tests in 176 files on each architecture; ARM regular Chromium 95 passed, AMD 94 passed plus one retry pass; both have one HTTP-only skip. Plain HTTP 25 passed each.                                                  |
| ARM64 acceptance                                                 | dev passed; Pi core observed   | [Native package workflow 4](https://github.com/goktugcy/everyos/actions/runs/40433524915): all six scenarios pass on ARM64 and AMD64; owner-approved temporary Pi core observation and cleanup below.                                                  |
| AMD64 acceptance                                                 | dev passed                     | The same native Ubuntu package qualification passes all six install/update/restore/revocation scenarios.                                                                                                                                               |
| Security regression tests                                        | dev passed                     | Network scoping/DNS rebinding/metadata/redirect tests, sandbox tests, signatures, tamper handling and zero production dependency advisories.                                                                                                           |
| CI green                                                         | checkpoint passed              | [CI 125](https://github.com/goktugcy/everyos/actions/runs/40433524906) passes both architectures and audit for `2451554` (clean PR test merge `1a27003`); the AMD terminal retry is recorded below.                                                    |
| Release artifacts verified                                       | production pending             | SDK/app/deb development artifacts verified; final protected signatures and independent release verification remain.                                                                                                                                    |
| Release candidate prepared                                       | local only                     | `0.1.37` is an unpublished local candidate; the pinned community anchor and matching live receipt are present. No tag, publication or main merge.                                                                                                      |

## Official apps

The first sixteen apps were implemented and tested before the network-app handoff; the baseline
verification below records their shared gate. The table now consistently marks their development
evidence alongside the subsequent apps. The owner's 2026-10-24 scope revision keeps 29 apps;
SQL Client, Video Player, Image Viewer and Gallery complete their development evidence below.
All 29 tested apps still require the remaining public-release gates.

The official registry trust anchor is pinned to the GitHub release index and the owner's public
key (see [publishing](app-sdk/publishing.md)). `anchors.test.ts` verifies the URL, fingerprint
and independently retained community key; `packages/catalogs/src/fetch.test.ts` verifies GitHub's latest →
versioned release → object redirect with public DNS pinned at every hop, credentials dropped
across origins, and private/metadata/mapped-address redirects refused. These five focused tests
passed on 2026-10-22. Production official-artifact publication and the complete signed official catalog remain open; the community anchor is now pinned after the real live lifecycle.

| #   | App             | Id                        | Status |
| --- | --------------- | ------------------------- | ------ |
| 01  | Notes           | `dev.everyos.notes`       | tested |
| 02  | Markdown Editor | `dev.everyos.markdown`    | tested |
| 03  | Calculator      | `dev.everyos.calculator`  | tested |
| 04  | Calendar        | `dev.everyos.calendar`    | tested |
| 05  | Pomodoro        | `dev.everyos.pomodoro`    | tested |
| 06  | To-Do           | `dev.everyos.todo`        | tested |
| 07  | PDF Viewer      | `dev.everyos.pdf`         | tested |
| 08  | Text Editor     | `dev.everyos.text`        | tested |
| 09  | Whiteboard      | `dev.everyos.whiteboard`  | tested |
| 10  | Code Editor     | `dev.everyos.code`        | tested |
| 11  | JSON Studio     | `dev.everyos.json`        | tested |
| 12  | Regex Tester    | `dev.everyos.regex`       | tested |
| 13  | SQL Client      | `dev.everyos.sql`         | tested |
| 14  | Diff Viewer     | `dev.everyos.diff`        | tested |
| 15  | Cron Builder    | `dev.everyos.cron`        | tested |
| 16  | JWT Inspector   | `dev.everyos.jwt`         | tested |
| 17  | Color Studio    | `dev.everyos.color`       | tested |
| 18  | Port Inspector  | `dev.everyos.ports`       | tested |
| 19  | DNS Lookup      | `dev.everyos.dns`         | tested |
| 20  | SSL Inspector   | `dev.everyos.ssl`         | tested |
| 21  | HTTP Monitor    | `dev.everyos.httpmonitor` | tested |
| 22  | Log Viewer      | `dev.everyos.logs`        | tested |
| 23  | Disk Explorer   | `dev.everyos.disk`        | tested |
| 24  | SSH Keys        | `dev.everyos.sshkeys`     | tested |
| 25  | Network Tools   | `dev.everyos.network`     | tested |
| 26  | Uptime          | `dev.everyos.uptime`      | tested |
| 27  | Video Player    | `dev.everyos.video`       | tested |
| 28  | Image Viewer    | `dev.everyos.images`      | tested |
| 29  | Gallery         | `dev.everyos.gallery`     | tested |

## Measurements

Actual package sizes, Linux/Mac app observations and virtualized core startup, RSS and idle CPU
samples are recorded below. The owner approved one bounded, temporary physical Raspberry Pi 5 core
measurement; its result and cleanup are recorded in the latest checkpoint. No candidate installation
or physical Pi browser test was performed. The Pi remains read-only outside that completed exception.

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
picker and confirms that inspection made no connection to the fixture. The arm64 job in CI run 109
now passes both the regular and plain-HTTP Linux paths, verifying the actual listening port and
CSV contents without making a connection to the fixture.
The full local gate passes under UTC/CI settings: format, lint, typecheck, 1,310 tests in 145
files, build, all 13 foundation/official-app Chromium tests and a clean production audit.
The first-run and Port Inspector browser workflows also pass over plain HTTP at `everyos.lan`
(two tests); this macOS run verifies honest unavailability, saved filters and mobile layout.

### Network Tools and PDF title synchronization

Network Tools reads source-tagged interfaces, addresses/prefixes, link metadata, reported default
gateways, DNS and configured reachability through the existing typed operations. An interface
selector keeps the detail panel compact and persists the selection. The separate traffic table
retains all measured interface rates, source and measurement/retrieval times; unavailable values
remain explicit. Optional polling pauses on suspend, waits for pending reads and refreshes on
resume. Policy-approved HEAD checks verify TLS and every redirect, distinguish a received HTTP
response from a successful status, and fence late results after permission revocation.

Nine logic tests and seven interface tests pass, including safe URL normalization, source and
timestamp preservation, partial-data errors, report redaction, selection and draft persistence,
permission changes and suspended polling. All ten locales validate. The first focused Chromium
workflow passed using actual host interfaces and a real HTTP endpoint: no connection before policy
approval, a HEAD response afterward, a JSON report through the destination picker and mobile
reopening. The compact selector passes the fresh full gate under UTC/CI settings: format, lint,
typecheck, 1,326 tests in 147 files, build, all 14 foundation/official-app browser tests and a
clean production dependency audit.
The first-run and Network Tools browser workflows also pass over plain HTTP at `everyos.lan`
(two tests). The final desktop and 390 px mobile selector layouts were visually reviewed, with
no horizontal overflow.

[CI run 109](https://github.com/goktugcy/everyos/actions/runs/39836304500) passed its production
audit. Its amd64 unit suite exposed a PDF Viewer test that read the desktop title before the
asynchronous bridge delivered it, although the toolbar had already updated. The exact
`Field guide` expectation now waits for the bridge; the other restoration, zoom, rotation and
bookmark assertions remain intact. Both PDF test files pass under UTC/CI settings (13 tests).
The [arm64 job](https://github.com/goktugcy/everyos/actions/runs/39836304500/job/120026097351)
passed 1,310 tests, all 86 regular browser tests and all 16 additional plain-HTTP tests, including
HTTP Monitor and actual Linux Port Inspector data. The amd64 PDF title fix still needs hosted
verification; the full release remains open.

### Log Viewer and CI duration

Log Viewer uses the authorized `logs.query` host operation for exact unit names, literal
case-insensitive message search, severity thresholds, relative/custom time bounds and older
cursor pages. Its live view polls every three seconds while active, permits one read at a time,
pauses on suspend and freezes an outstanding poll when paused. The buffer deduplicates cursors,
keeps at most 1,000 entries / 4 MiB of encoded records, resets on a source change and reports
limits, live gaps and stale reads. Full collected messages and metadata open from table rows.
Twenty logic/interface tests pass, including time validation, byte limits, source separation,
pagination, presets, report contents and revocation of an outstanding read. All ten locales
validate; common log labels and severity names reuse the core translations.

The focused Chromium workflow passes through the real sandbox bridge using the explicitly
simulated development journal source. It verifies a new live record, a frozen view for two poll
intervals after pause, severity/text/unit filters, an accessibly labelled host prompt, a saved
filter, an actual JSON report with its `simulated` source and mobile reopening without horizontal
overflow. It does not claim to have read a native journal in this development browser run.
The native journal provider has three new query/follow regression tests: literal metacharacters,
unchanged read-only command/resource bounds and a missing collector. The provider now escapes
the search string to match the SDK's documented literal behavior and the simulator.

[CI run 110](https://github.com/goktugcy/everyos/actions/runs/39840317385) passed its audit and
entire arm64 job. The amd64 job passed 1,326 tests and 87 regular browser tests, including Network
Tools. Its additional 17-test plain-HTTP pass then reached the 35-minute job deadline; no failing
product assertion preceded cancellation. The matrix job now allows 45 minutes for both passes,
with all test commands and assertions retained. The normal browser pass excludes the existing
plain-HTTP-only test, which runs in the additional insecure-origin pass.

The Log Viewer checkpoint passes format, lint, typecheck, 1,349 tests in 150 files, the production
build and all 15 first-run/official-app browser scenarios. Dependency audit reports no known
vulnerabilities. Desktop and 390-pixel mobile screenshots were reviewed, including the saved
filter name and its adjacent removal button.
The first-run and Log Viewer workflows also pass over plain HTTP at `everyos.lan` (2/2).

[CI run 111](https://github.com/goktugcy/everyos/actions/runs/39916244747) finishes successfully
on both architectures, including the complete browser suite and the extra plain-HTTP pass.
Each architecture passes 1,349 tests in 150 files and all 18 plain-HTTP scenarios. The regular
amd64 pass reports 88 passed / 1 intentionally skipped insecure-origin scenario. The arm64 pass
reports 87 passed / 1 flaky / the same intentional skip: the existing terminal shell-exit test
timed out waiting for `ended` once and passed on its configured retry. That terminal test and
client remain unchanged under the owner's explicit scope restriction. Log Viewer's normal and
plain-HTTP workflows pass on both architectures without a retry.

### Disk Explorer

Disk Explorer measures only a persistent, read-only directory handle chosen by the person.
It restores relative navigation, renders per-child size bars and 100-row pages, finds the largest
50 files, summarizes the largest 50 extension groups and exports all collected rows as JSON.
Mounted storage is a separate source-tagged view with capacity, used/available bytes, filesystem,
device, access mode and inode availability. Capacity values from potentially overlapping mounts
are never added together. File lengths are distinguished from filesystem allocation.

Its 14 logic/interface tests pass: bounded restored settings/history, safe relative navigation,
sample/time spacing, source separation, picker access, persisted folder restoration, pagination,
complete exports, partial scans, simulated-source labels, stale reads and permission/file-share
revocation. Actual observations are kept for at most 8 scopes / 24 samples per scope / 160 KiB;
refreshes within 15 seconds replace an observation. Incomplete folder scans do not enter history.
All 64 translation keys are supplied in ten languages.

Five new provider regression tests cover unreadable descendants, scoped nested totals, symlinks,
listing/depth limits, the global 50,000-entry budget and deadlines between direct children.
Those tests and the existing SDK API integration suite pass together (36/36, including MariaDB).
The provider now reports inaccessible descendants as partial and applies its count/time guards
to direct children as well as nested directories.

The focused Chromium workflow passes through the actual sandbox, file picker and API. It measures
real temporary files, enters a child folder, observes a real 512-byte increase after the sampling
interval and verifies both actual totals in the exported trend (6,272 then 6,784 bytes). The JSON
report excludes a larger sibling outside the shared folder. The workflow also checks actual mounted
storage, persists the folder's relative location and reopens at 390 pixels without horizontal
overflow. Desktop and mobile screenshots were reviewed.

The full checkpoint passes format, lint, typecheck, 1,368 tests in 153 files, the production build
and all 16 first-run/official-app browser workflows. Dependency audit reports no known vulnerabilities.
The first-run and Disk Explorer workflows also pass over plain HTTP at `everyos.lan` (2/2).

[CI run 114](https://github.com/goktugcy/everyos/actions/runs/39923220292) passes the audit and
both full Linux architecture jobs: 1,368 tests in 153 files, 89 regular browser scenarios and
19 extra plain-HTTP scenarios on each. Each normal pass intentionally skips the existing
insecure-origin-only scenario, which is exercised in the additional HTTP pass. No scenario
requires a retry in this run; Disk Explorer passes both browser modes on both architectures.

### Uptime

Uptime reads source-tagged host uptime/boot time and service state, and manages its own approved
HTTP endpoint checks through the existing monitor scheduler. Settings include interval, timeout,
expected status range, failure threshold, notifications and enabled state. Checks use GET with
verified TLS; targets and redirects remain behind the App Store network policy. Service actions
are read-only. Its health summary requires complete, real, fresh data for a passing result;
missing, stale, simulated and pending observations remain incomplete. Failed reads retain their
last measured values while changing the summary to insufficient data.

The 24-hour/seven-day availability figures are measured check rates. History has 100-row pages,
up to 5,000 retained checks and a latest-60-check timeline. Incident observations are actual
transitions into failed/blocked checks and first subsequent success, capped at 100; an initial
failure is marked as a partial start. No past service incidents or precise downtime intervals
are inferred. The window and widget poll every 15 seconds while active, suspend/resume cleanly
and fence revoked/late reads. Endpoint drafts persist and ask before discard. All 138 locale keys
are supplied in ten languages. The widget declares its own capability subset and its implementation
only reads host information, services and this app's monitor list, then opens the full window.

Seventeen logic, interface and widget tests pass, including source separation, overdue/stale
health, safe targets/configuration, check transitions, draft restoration, confirmation, lifecycle
polling, permission revocation, notifications configuration and widget opening. The first focused
Chromium run passes with real measured host uptime, a loopback endpoint blocked before policy
approval, actual 200/503 responses, a server notification, widget/window sharing and mobile reopening.
The development service source stays explicitly simulated. Screenshot review prompted a smaller
widget summary with the simulated-source badge moved into its first row. The second focused run
passes with an explicit viewport assertion for that badge; its new screenshot was reviewed. The
full checkpoint passes format, lint, typecheck, 1,385 tests in 155 files, the production build
and all 17 first-run/official-app browser workflows. Dependency audit reports no known vulnerabilities.
The first-run and Uptime workflows also pass over plain HTTP at `everyos.lan` (2/2).

[CI run 115](https://github.com/goktugcy/everyos/actions/runs/39928725993) passes the audit and
both Linux architecture jobs: 1,385 tests in 155 files, 90 regular browser scenarios and
20 extra plain-HTTP scenarios on each. The regular pass intentionally skips the existing
insecure-origin-only scenario, exercised in the additional HTTP pass. No test requires a retry.

### SSH Keys

SSH Keys manages the person's existing EveryOS vault through `ssh.keys.*`: six generated key
algorithms, public-only import, fingerprints, names/comments, filtering, public export and
explicit protected private export. The user vault is shared across authorized apps; existing
host private-key files are never read. The app declares only `secrets:ssh`, `files:save` and
`clipboard:write`, with no app storage, file picker or widget. Private exports require matching
passphrases and EveryOS's own fingerprint confirmation. Public-only deletion asks through the
app dialog service; a private key requires the desktop's fingerprint confirmation. All 57
translation keys are present in ten languages.

The focused platform regression run passes 41 tests, including the existing MariaDB integration
suite. New checks cover complete public-key wire parsing, canonical RSA mpints and real bit
lengths, ECDSA curve/point validation, required security-key application fields, native P-521 and
RSA 4096 interoperability, the full 1,023-byte UTF-8 export-passphrase boundary, concurrent crypto
refusal with metadata reads still available, and widget private-export/deletion denial even when
caller input says confirmed. Generation uses Node's async key API and generation/protected export
share a bounded crypto slot. Metadata changes and denied private actions are audited without
secret details. This was a focused source review and regression implementation, not a full audit.

Fifteen app logic/interface tests pass for metadata validation, supported public input, immediate
private-paste clearing, UTF-8 passphrase limits, filtering, generation/import/update, public and
protected exports, password clearing, cancellation, suspend/resume polling, stale snapshots,
missing-tool/busy errors, both deletion paths and permission changes during export or a picker.
No secret is written to app storage or copied to the clipboard. Clearing JavaScript inputs does
not claim to overwrite garbage-collected process memory.

The focused Chromium workflow passes real Ed25519 generation, metadata persistence across close
and reopen, public export, declined and approved native private-export confirmation, protected
file output, public import and declined/approved deletion of each key type. The exported OpenSSH
file has a non-plaintext cipher and `ssh-keygen -y` with the disposable fixture passphrase derives
the same public identity. The workflow also passes at 390 pixels without horizontal overflow.
Screenshot review prompted a mobile table with name/material columns and algorithm/bits in the
selected-key details, avoiding character-by-character numeric and algorithm wrapping.

The complete SSH checkpoint passes formatting, lint, all typechecks, 1,410 tests in 159 files,
the production build and all 18 first-run/official-app browser workflows without a retry.
The production dependency audit reports no known vulnerabilities. The first-run and SSH Keys
workflows also pass over plain HTTP at `everyos.lan` (2/2).

## Remaining release work — updated 2026-10-24

SQL Client, Video Player, Image Viewer and Gallery are now implemented and tested below. The
owner removed API Client, Music Player, Wallpaper Studio and Icon Studio; the release target is
29 apps. The remaining release work is:

- Qualify the implemented all-29-app distribution pipeline in hosted CI and, after explicit
  publication authorization, run it with the protected production keys. Local development
  signing uses ephemeral keys; it is not a production-signed release candidate.
- The community service (`services/community-registry`) using Workers, R2 and D1, its local
  tests and developer guide. The owner still supplies the domain and performs deployment;
  no account token is needed by the coding agent. Pin the community anchor after deployment.
- Synchronize and verify the existing manifest/SDK references, finish the remaining app and
  community documentation, measure Pi/amd64 package sizes, startup and resource use, and fill
  every final acceptance gate with evidence. CI already exercises official-app workflows on
  both architectures and over plain HTTP; final acceptance must cover the completed set of 29.

The Pi remains read-only. No tag, public release or main-branch merge is part of this checkpoint.

## Selected remaining apps — 2026-10-24

The owner's revised scope is SQL Client, Image Viewer, Gallery and Video Player. API Client,
Music Player, Wallpaper Studio and Icon Studio are removed from the config and workspace rather
than left as unimplemented catalog entries. The complete public release target is 29 apps.
The core network/appearance SDK capabilities remain available for authorized third-party apps.

CI 116 for `c175fd7` did not qualify the branch. The amd64 job stopped in Whiteboard's existing
unit test: it took a snapshot of the initial empty saved board while its 800 ms edit debounce
was still pending. The test now waits for `BoardStore.load` to return the actual rectangle/arrow
before snapshotting and retains all original assertions. The arm64 job passed unit tests and
all official-app workflows but failed the protected terminal shell-exit scenario on both
attempts. Its extra plain-HTTP pass succeeds (21 scenarios). Terminal client files and
`tests/e2e/tools-terminal.spec.ts` remain untouched. The dependency audit succeeds. See
[CI run 116](https://github.com/goktugcy/everyos/actions/runs/40009529232).

### SQL Client

Nine app tests pass for scalar parameters, safe identifier quoting, bounded preferences,
formula-safe complete-snapshot CSV, read-only query defaults, connection testing, session history,
real database error details and revoked late results. All 39 keys are supplied in ten locales.
The actual PostgreSQL browser workflow passes using an owned disposable database and restricted
login. It checks metadata, connection version, read-only write rejection, declined/approved native
writes, complete confirmation of SQL longer than 20,000 characters, CSV, restoration privacy and
390-pixel layout. Credentials do not reach the app. Query text/results/parameters remain transient;
only non-secret connection/limit settings persist. Desktop/mobile screenshots were reviewed.

### Image Viewer

Nine logic/interface tests pass for restored references, bounded stream reads, EXIF failure,
preview transforms, unchanged original export, selection restoration, slideshow suspend and
revocation fences. All 26 keys are supplied in ten locales. The actual browser workflow decodes
real synthetic PNGs, extracts an actual EXIF Make tag, verifies dimensions, zoom/pan/rotation,
compares exported original bytes,
restores selection and advances a mobile slideshow; damaged data has an explicit decode error.
Unknown restored handle size is not treated as zero or oversized. The reader enforces 50 MiB
while streaming. Temporary URLs and file bytes never enter app storage. Screenshots were reviewed.

### Gallery

Seven logic/interface tests pass for validated album indexes, safe relative paths, image/entry/
folder/depth/time/byte budgets, partial scans, search/favorites, restoration, bulk reference
removal, revoked folders and flushing pending edits before deleting album storage. All 60 keys
are supplied in ten locales. Each album has its own value, at most 1,000 images or 210 KiB;
thumbnail requests use four workers and pages of 40. The actual browser workflow indexes a chosen
folder and nested image, excludes a neighboring image, verifies native thumbnail decoding,
rescans while retaining favorites, renames/restores albums, runs a mobile slideshow and verifies
that bulk/album removal left original files untouched. Screenshots were reviewed.

### Video Player

Seven logic/interface tests pass for bounded playlists/positions, plain-text WebVTT/SRT cues,
codec hints, streaming without full-file reads, native resume, named playlist operations, decode
errors and revoked access. All 37 keys are supplied in ten locales. Its real-browser workflow
passes actual VP8 playback and range responses, speed/volume/mute, safe subtitle cues, fullscreen
entry/exit, resume after close/reopen, named playlists and 390-pixel layout. The small committed
fixture is a synthetic video generated with Chromium; CI needs no encoder or host installation.
Screenshots were reviewed. The strengthened workflow also passes decoded seek completion,
automatic next-video playback and stopping at the list end.

### Dependency follow-up

The first selected-app gate passed format, lint, typecheck, 1,442 tests, build and 22 browser
workflows, then stopped on newly reviewed dependency advisories. Zod is pinned to 4.6.6 for
direct and transitive v4 consumers, and Nodemailer to 10.1.4. These address the upstream
[collection-validation advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) and
[address-parser advisories](https://github.com/nodemailer/nodemailer/releases/tag/v10.1.4).
Installation passes the existing supply-chain policy without an exception; the production
audit reports zero advisories at every severity after the update.

### Final development gate

The fresh gate with the updated dependencies passes under UTC/CI settings: format, lint,
all package typechecks, 1,442 unit/integration tests in 167 files, production build, 22
foundation/official-app Chromium workflows and the production audit (zero advisories).
The official-app smoke workflow installs and launches all 29 signed development packages.
Each selected app also passes `everyos-app validate`; SQL's elevated permission warning is
expected and requires administrator approval. All ten locales validate for every package.

An additional browser pass over plain HTTP at `everyos.lan` passes 5/5: first-run setup and
the complete SQL Client, Image Viewer, Gallery and Video Player workflows. Desktop and
390-pixel screenshots are reviewed. This is development evidence on the Mac, not final
ARM64/AMD64 release qualification. [CI 117](https://github.com/goktugcy/everyos/actions/runs/40084914446) subsequently passes on
both Linux architectures: 1,442 tests each, 94 regular browser tests on amd64 / 95 on arm64,
and 25 plain-HTTP tests each. The dependency audit passes. The protected terminal scenario
also passes in this run; its CI 116 failure is retained above as historical evidence.

## Official distribution pipeline — 2026-10-24

The complete catalog is built, validated, packed, signed and verified by
`scripts/official-apps.ts`; [publishing](app-sdk/publishing.md) documents the commands and trust
boundary. A committed exact permission policy covers app and widget grants. The machine-readable
report binds each app's name/id/version, actual positive test counts, checksum, manifest/build,
compatibility, all-ten-locales and permission-policy status to its source and signing mode.
The report itself is signed with a domain-separated registry signature. Both CI architectures
now require the ephemeral-key development pipeline and retain its report. The protected release
job consumes only verified unsigned artifacts, matches both app signing secrets to the public
pins, checks previous-version immutability/sequence/revocations, and verifies all bytes again
before the existing publication step. Published assets have flat GitHub-compatible names.

The fresh 29-app development run passes 447 app tests and verifies all 29 packages/index
with ephemeral keys. Twenty-nine focused pipeline tests pass for deterministic archive bytes,
failed/skipped/missing tests, catalog coverage, changed permissions/default locale/localization,
SDK incompatibility, wrong signing keys, dirty source, modified report/package/icon data, missing
or extra/symlink assets, incomplete or expired signed indexes, source/policy drift, immutable
versions, rollback, retained revocations and credential-free asset downloads.

The complete local gate passes format, lint, all typechecks, 1,471 unit/integration tests in
168 files, production build, the 29-app pipeline with 447 actual app tests, all 22 foundation/
official-app Chromium workflows, and the production audit with zero advisories.
[CI 118](https://github.com/goktugcy/everyos/actions/runs/40094108344) subsequently passes on
both amd64 and arm64, including the 29-app artifact verification/report upload, regular and
plain-HTTP browser suites, and the dependency audit. This qualifies the distribution checkpoint;
new community changes need their own hosted run.

The owner explicitly keeps `locales.default: "en"` in all official manifests; the pipeline checks
that value and complete Turkish plus the other eight dictionaries. No production key was read or
used locally. Production signing, publication, packaged install/upgrade qualification, community
service and device measurements remain release gates.

## Community service development — 2026-10-25

The Cloudflare Worker, D1 migration, private R2 intake and developer CLI are implemented; see
[community submissions](app-sdk/community.md) for exact limits and owner deployment. Fourteen
integration tests run in actual Miniflare/workerd with D1 and R2. They cover authentication,
reserved/overlapping namespaces, operator-verified invitations, Ed25519 key proof and replay,
signed archive corruption/identity mismatch/decompression bombs, HTML/locales/raster checks,
private pending uploads, owned artifacts, human review/rejection/resubmission, concurrent
approval, immutable versions, updates, revocation, anonymous report limits/resolution, token
rotation/recovery, context-bound SecretBox credentials on disk, audit redaction and scheduled refresh. The real Node CLI enrolls, submits and
reads status through the local HTTP listener. Missing R2 objects preserve the previous valid
catalog with publication pending; concurrent snapshots cannot lower its sequence.

The final complete local gate passes format, lint, all typechecks, 1,486 tests in 170 files
(including 14 workerd integration cases and the isolated production-config test), production
build, Worker dry-run bundle, 29-app distribution verification with 447 app assertions, all 22
foundation/official-app Chromium workflows, and the production audit with zero advisories.
No production registry/admin key or Cloudflare account token was read. Fresh hosted CI for the
community commit is still required; CI 118 above qualifies the preceding distribution checkpoint.

The owner's domain is `everyos.goktugceyhan.dev`. The owner still needs to create production
D1/R2 resources, supply separate registry/admin secrets, deploy, verify the public key and service
round trip, then pin `COMMUNITY_APP_REGISTRY`. The development agent has not performed any of
those remote actions. The official manifests still default to English, and all 29 apps remain
in scope. Standalone SDK/CLI distribution (`npx` included), packaged Linux install/upgrade
qualification, Pi/amd64 resource measurements, final
document synchronization and the final complete-release acceptance remain open. No tag, release
or main-branch merge is performed by this checkpoint.

## Standalone SDK and packaged ARM64 qualification — 2026-10-25

The local candidate is **0.1.37**, not a published release. The owner confirmed that no community
domain, Worker, D1 database or R2 bucket has been provisioned. The release package job now runs
`scripts/release-preflight.ts` before signing: the absent anchor currently produces the expected
hard failure. A matching, current live acceptance receipt and a fresh signature-verified deployed
index are required. See [standalone distribution](app-sdk/distribution.md).

The five actual npm-compatible archives install independently of this workspace. Qualification on
macOS arm64 (Node 26.10.0) and a disposable unprivileged Linux arm64 container (Node 26.11.1) passes
all four templates: vanilla (one test), React (one), React/widget (three) and hybrid (one). Each run
checks real installation with scripts disabled and no workspace links, declarations/typechecking,
tests, packaging, signed private publication/refresh/revocation and the packaged developer server.
The widget case compiles the public UI package and renders/clicks its actual installed components.
CI now repeats the qualification on amd64 and arm64.
The SDK report and acceptance reports remain development evidence from a dirty feature checkout;
they are not production signatures or final release provenance.

| Archive                       | Bytes  |
| ----------------------------- | ------ |
| everyos-app-sdk-1.0.0.tgz     | 19,106 |
| everyos-app-testing-1.0.0.tgz | 12,720 |
| everyos-app-ui-1.0.0.tgz      | 36,216 |
| everyos-app-cli-1.0.0.tgz     | 43,723 |
| create-everyos-app-1.0.0.tgz  | 28,710 |

Both OS packages build and contain 392 runtime/package files without SDK, catalog or acceptance
artifacts: arm64 61,833,402 bytes; amd64 62,078,284 bytes. The amd64 package has not yet been
installed in a dedicated amd64 host by this checkpoint.

`tests/sdk-linux/qualification.py` runs only inside the newly created dedicated
`lima-everyos-sdk-qual-20261025` VM (Ubuntu 24.04 ARM64, 2 vCPUs, 3 GiB RAM, no host mounts).
It verifies six real scenarios:

1. Install the published 0.1.36 baseline with its published Ed25519 signatures and package digest.
2. Link a genuine Linux fixture account using PAM, unlock sudo, then authenticate an update to
   0.1.37. Preserve the account login, home sentinel, owner config and API/agent keys.
3. Install and update a real packaged Notes-derived app through an ephemeral local signed registry;
   preserve its SDK storage across the app update.
4. Create and verify a backup containing the installed app and account home.
5. Change app/home data, restore through the authenticated CLI, observe the supervised API restart
   and verify the original app/home data after reauthentication.
6. Sync a signed revocation and verify that the installed app is revoked and cannot launch.

Only the initial baseline uses the published release key. The unpublished candidate, rollback
metadata and local app registry use clearly separate ephemeral test keys; no production private
key is used. Candidate package digests are recorded in the Linux receipt. The VM is stopped after
evidence extraction; pre-existing host services and the owner's Pi are untouched.

One warm core restart-to-healthy sample measured **261.80 ms**. After the restore, API RSS measured
**144,988 KiB**, agent RSS **98,984 KiB**; neither process accumulated a measurable CPU tick in the
five-second idle sample. These are VM observations, not app window launch measurements, averages,
physical Pi results or native amd64 benchmarks. The requested device/app resource measurements
remain open.

The full local unit/integration run passes **1,500 tests in 173 files**, with real temporary
PostgreSQL and the existing MariaDB fixture. The 29-app ephemeral artifact pipeline passes all
447 app assertions. Worker dry-run and the production dependency audit pass (zero advisories).
The Store event-stream-loss browser regression passes without retries. Its finite polling fallback
now updates running jobs every second and stops after a terminal response; delayed results from
another job cannot overwrite the requested job.

The full browser follow-up exposed fixture preparation races: the old helper mounted restored
windows and security preferences before resetting them. A subsequent navigation could lock the
session and leave the following test's cleanup incomplete. The helper now authenticates through
the real same-origin API from an inert document, asserts HTTP 200 and authenticated status, resets
preferences, then mounts the desktop once. The wrong/correct password, language and sign-out/login
UI flows remain covered directly by `foundation.spec.ts`. All 16 affected browser workflows pass
without retries, including secure/normal backups, Finder, desktop files, widgets and the unchanged
terminal tests. The complete reruns below also pass with the fixture fix.

The HTTP follow-up exposed a pre-existing shelf race: a drop before the initial writable-home
lookup was silently ignored.
The shelf now resolves that lookup before accepting the upload and reports loading with
`aria-busy`. The HTTP regression deliberately holds the real root response until after the drop;
setup and that deterministic regression both pass. The rebuilt candidate then passes the full
regular browser run (**95 passed**, with the one HTTP-only conditional skip) and the full HTTP
run (**25 passed**) without retries. Both SDK runtime qualifications, 29-app artifact verification
and the six-scenario Linux package qualification also pass on the rebuilt candidate. The current
ARM64 package digest is `c32ad0ebec180d1d3e64ff8f398feb18a4553854567e109c84cf135c505b6269`.
The sanitized [development receipts](evidence/sdk-20261025/) record these local artifacts and runtime
observations; their dirty-source marker is intentional. They do not replace clean hosted CI or
production signing. The test VM is stopped after extracting the final receipt.

[CI 119](https://github.com/goktugcy/everyos/actions/runs/40202231710) failed its separate official-app
test subprocess on amd64; the previous script discarded its detailed JSON. Failure diagnostics
now preserve suite/test names and error kinds without printing assertion values.
[CI 120](https://github.com/goktugcy/everyos/actions/runs/40204669848) passed that artifact gate but
failed the Store browser regression above. Neither run qualifies this new checkpoint. Fresh hosted
CI, live community acceptance, native amd64 packaged acceptance,
physical Pi measurements and final evidence synchronization remain required before public release.

## Native hosted Linux package qualification — 2026-10-25

The dedicated [package workflow](https://github.com/goktugcy/everyos/actions/runs/40230342700)
passes on **both native amd64 and arm64 Ubuntu 24.04 runners** for
`f0e302f85c691b2f11524e57dd0d010b727d694f`. Each runner completes all six real scenarios above,
including the published 0.1.36 installation, PAM/sudo boundary, authenticated 0.1.37 update,
app update with persistent SDK data, verified backup/CLI restore and signed revocation.
The preparation refuses existing EveryOS state and self-hosted machines; failure diagnostics and
cleanup run only after that preparation succeeds. The guard has six Python regression cases,
also exercised by `pnpm check` (1,501 tests in 174 files).

Both sanitized receipts were downloaded from GitHub and their ZIP SHA-256 values checked against
GitHub's artifact metadata before extraction:

| Architecture | Receipt                                                                    | Artifact id | Artifact ZIP SHA-256                                               |
| ------------ | -------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| amd64        | [receipt](evidence/sdk-20261025/hosted-sdk-linux-qualification-amd64.json) | 12611679776 | `43e84af4c91d8e43e9f3ef96571ab09d28b32593ab9990b9caac12a6b2826eb2` |
| arm64        | [receipt](evidence/sdk-20261025/hosted-sdk-linux-qualification-arm64.json) | 12613075694 | `66795c42c5ad5cd3a1eb9a27cd28d39f2f7a9a97de1005bbe9caf6acc66e464c` |

The actual tested candidate package digests are
`6ada0fdf146d955f541af7d64559dfb3af8c7f4ec98cff5d3139a84eb59c7518` (amd64) and
`2fe4a697bb74a70e92ab07f87b1e8c9984ebc49240fe211a76af303dcd4ec4f3` (arm64).
Each receipt binds its baseline and candidate package bytes. These are independent fresh builds,
not the earlier local VM package bytes, and use ephemeral candidate/app signing keys.

| Native VM observation                    | amd64       | arm64       |
| ---------------------------------------- | ----------- | ----------- |
| Warm core restart to healthy             | 453.81 ms   | 459.38 ms   |
| API RSS after restore                    | 146,332 KiB | 144,524 KiB |
| Agent RSS after restore                  | 102,860 KiB | 98,964 KiB  |
| API CPU in the five-second idle sample   | 0.0%        | 0.4%        |
| Agent CPU in the five-second idle sample | 0.2%        | 0.2%        |

These single samples describe virtualized core services. They are not averages, individual app
window measurements or physical Pi results. The native AMD64 package gate is now satisfied;
physical Pi/app measurements remain open. The main regression workflow for the same checkpoint
is [CI 122](https://github.com/goktugcy/everyos/actions/runs/40230342559), still pending when this
package evidence was extracted. CI 121 passed ARM64 but its AMD64 HTTP stage was cancelled by
the subsequent push; it is not recorded as an entirely successful run.

The remaining publication gates are the owner's production Cloudflare/domain deployment, pinned
public community key and live six-step acceptance, physical device measurements, final protected
signing/verification and explicit owner approval. No production service, tag, npm publication or
public release was created by this qualification.

The final local pre-push run passes format/lint/types, **1,501 tests in 174 files**, build and all
**22 foundation/official-app browser workflows** without retries. Inspection of the hosted SDK
artifacts exposed generated Python bytecode marking the source as dirty. The Mac normally disables
bytecode generation; explicitly enabling CI's behavior reproduced the untracked caches in both
`scripts/` and `tests/sdk-linux/`. Repository-local `__pycache__/` exclusion fixes that generated
state without excluding source files. CI now refuses a dirty tree before recording SDK provenance;
subsequent hosted runs must verify that clean state. Earlier dirty development receipts remain honest
historical evidence and are not relabeled as clean release provenance.

CI 122 subsequently completed successfully on both architectures, including the standalone SDK,
29-app artifact verification, regular and plain-HTTP browser suites, plus the dependency audit.
The final provenance/workflow/documentation follow-up retains these results as checkpoint evidence;
its current head checks and receipts are linked from [PR #1](https://github.com/goktugcy/everyos/pull/1).

## Community deployment handoff follow-up — 2026-10-26

The owner now has `pnpm community:inspect --public-key <independently-retained-public.pem>` for
read-only production health, discovery identity, published public key and signed-catalog verification.
It uses the existing public DNS-pinned bounded transport, refuses redirects and rejects private-key
input before any request. Its distinct deployment-report format cannot satisfy the human-reviewed
six-step live acceptance gate. Release preflight repeats these checks after the existing anchor and
live-evidence gates. No production probe was claimed to pass without the owner's deployment/key.

The [operator handoff](app-sdk/community.md#operator-local-development-and-deployment) now describes
the actual first deployment with both required secrets supplied using `--secrets-file`. It also
clarifies that the Worker Custom Domain creates DNS and a certificate on the active Cloudflare zone;
the owner does not need to pre-create an A/CNAME record for the new subdomain. No secrets, resources,
DNS records or Worker versions were created by this local implementation.

The focused checks pass **44 tests**, including **15 actual workerd/D1/R2 scenarios**. A dedicated
fresh production-configured local Worker initially fails inspection without a published catalog,
then passes after a real authenticated initial publication to D1/R2. Other checks refuse wrong or
private keys, local health, identity/origin drift, changed/expired/unrelated catalogs, redirects and
credential-bearing transport errors. These are local integration checks, not the missing deployed
community lifecycle acceptance.

The complete local pre-push gate passes format/lint/all typechecks, **1,523 tests in 175 files**,
production build and **24 foundation/official-app/SDK browser workflows** without retries. The
Node-only transport explicitly imports Node's URL type so the Worker test environment cannot
substitute its incompatible ambient URL type. The absent production community anchor still causes
the expected release-preflight failure before reading live evidence or making network requests.
Fresh hosted checks for this follow-up are tracked by the draft PR; CI 123 above qualifies the
preceding checkpoint.

## Production community provisioning — 2026-10-26

The owner authorized real Cloudflare setup and completed OAuth, the Vercel domain-team move and
registrar nameserver activation. The Cloudflare zone is active. The site's apex and wildcard remain
DNS-only CNAMEs to their original Vercel targets; the three logical CAA records and Domain Connect
record are preserved. Both assigned nameservers returned the expected targets, and the current and
prepared apex/www targets passed four HTTP 200 checks with certificate validation. All five `.dev`
parent nameservers now delegate to Cloudflare. See the [DNS evidence](evidence/community-20261026/dns-migration.json).

The real `everyos-community-registry` Worker uses the new `everyos-community` D1 database and
private R2 bucket. Migration `0001_registry.sql` applied successfully; the database has 14 tables.
R2's public development URL is disabled. The Worker has both required secret bindings, the
`everyos.goktugceyhan.dev` Custom Domain, no workers.dev/preview URL and daily cron `17 3 * * *`.
No existing unrelated Cloudflare resources were changed.

The dedicated community public-key fingerprint is
`sha256:424cf75d70fcf7b9711cf5ed9ed1e436a8602e42c868379c17c66a0fd7847ddf`.
The [independently retained public key](evidence/community-20261026/registry.pub) matched discovery
and `/registry.pub` over verified TLS before any authenticated request. Initial publication returned
HTTP 200 and created signed catalog sequence **1**, with zero publishers, apps and revocations.
The [publication record](evidence/community-20261026/initial-publication.json) states the exact
network pin used during partial DNS propagation; it contains no credentials.

The four production deployment checks pass using the existing strict DNS-pinned fetcher with
**Google DNS (8.8.8.8)**: production health, discovery identity, published key and signed catalog.
The [network-qualified verification](evidence/community-20261026/deployment-verification-google-dns.json)
records this resolver explicitly. The local default resolver and 1.1.1.1 still returned cached
Vercel answers during this checkpoint, so the ordinary `pnpm community:inspect` command failed
`service-health`. No default-resolver pass or six-step lifecycle acceptance is claimed. Once DNS
propagation completes, repeat the ordinary command and retain its result.

The production community anchor remains unset. Real enrollment, submission, **human review**,
installation, update and revocation must still be completed before pinning it and recording live
acceptance. No main merge, tag, npm publication or EveryOS public release occurred.

### Default-resolver production verification follow-up

At `2026-10-26T18:03:08.895Z`, the ordinary `pnpm community:inspect` command passed all four
production checks using the default DNS resolver, with no alternate resolver or endpoint override.
The [default-network receipt](evidence/community-20261026/deployment-verification.json) verifies
signed catalog sequence 1 against the independently retained public key. Earlier propagation
failures remain historical evidence; they are superseded by this successful check.

Direct HTTPS checks returned HTTP 200 for `/health`, `/.well-known/everyos-registry` and
`/index.json`. The API-only service has no root landing page, so `/` returns the normal HTTP 404
`{"error":"not-found"}` response. The desktop app store remains part of EveryOS itself. This
read-only production verification does not satisfy the six-step human lifecycle acceptance gate.

## Local official-app sync follow-up — 2026-10-26

The running development API used the pinned GitHub release URL, which returned HTTP 404 because
`official-apps.json` has not yet been publicly released. The new development registry uses the
existing full artifact pipeline: **29 real apps**, **447 app assertions**, package validation and
ephemeral signatures. A development-only generated anchor connects it to the normal API sync path;
production pins and all signature checks are preserved. See [D63](decisions.md#d63--local-development-serves-real-signed-official-app-builds)
and the [development workflow](development.md#official-desktop-apps-during-development).

The real local API synchronized all 29 entries without a registry error. The existing authenticated
browser session's **Sync now** action succeeded and removed its old error; the Official catalog
rendered all 29 app cards, including SQL Client, Image Viewer, Gallery and Video Player. Transport
checks independently downloaded and verified all 29 package sizes, hashes and signatures and all
29 icons. Four unknown/traversal paths returned 404, writes returned 405 and HEAD returned no body.

Focused API/configuration/transport checks pass **48 tests**, with PostgreSQL and MariaDB fixtures
required and no skips. All workspace typechecks, changed-file lint and production build also pass.
These are current local checks; the earlier hosted CI/native receipts still refer to `f67f18a`.
No public official index, npm package, release or production signing key was created by this fix.

## Local installed-app runtime follow-up — 2026-10-26

The development Vite server forwarded `/api` but missed `/app-runtime`. Installed app documents,
scripts, locales and icons therefore received the desktop HTML fallback. The proxy now forwards
runtime paths to the same API while preserving the original Host and Origin headers.

Live checks against the existing HTTP Monitor installation confirm identical API/proxy bytes,
content types, CSP and CORS for its document, JavaScript module, English locale and SVG icon.
Unknown runtime files still return 404. The authenticated local browser opens HTTP Monitor to its
working empty state with enabled controls; its icon is visible in the installed list, window header
and dock. Reinstallation was unnecessary. The existing desktop-app API suite passes **35 tests**
with both database fixtures required and no skips; web typecheck and changed-config lint pass.
These development checks do not replace the full pre-push or release acceptance gates above.

## Resource observation follow-up — 2026-10-27

The [29-app browser report](evidence/sdk-20261027/official-app-measurements-macos-arm64.json)
records actual first-window observations on an Apple M2 Mac (8 logical CPUs, 16 GiB memory),
Chromium 156.0.8078.4, using the disposable 0.1.37 development stack. All 29 packages installed,
reached visible content and closed; no runtime request failed. Launch time from command-palette
activation to visible content ranges from **1,805.71 to 1,901.10 ms** (median **1,829.11 ms**).

Every sample used the desktop renderer including its app frame. The three-second idle task-time
observations range from **0.45% to 2.44%** of one main thread (median **1.07%**). Renderer
JavaScript heap in use ranges from **26,028,384 to 111,732,364 bytes**; it includes the desktop and retained
allocations from earlier apps. These are neither isolated per-app heaps nor host-service RSS.
Runtime response bodies range from **301,088 to 1,726,950 bytes** per launch; installation and API
requests are excluded. Cache state is uncontrolled and these are single sequential samples,
not population averages or a physical Pi performance claim. The [collection method](development.md#official-app-resource-observations)
and retained machine-readable samples make the scope explicit. CI now collects the same
observations on both native Linux architectures; fresh hosted receipts remain to be obtained.

The [read-only physical Pi observation](evidence/sdk-20261027/pi-installed-0.1.36-readonly.json)
confirms a Raspberry Pi 5, Ubuntu 26.04.1 LTS and the existing **0.1.36** installation. API and agent
main-process RSS were **142,768 KiB** and **97,904 KiB**. Neither accumulated a scheduler tick during
the five-second sample; this does not imply zero sustained CPU usage. No process was restarted and
no file was written on the Pi. Candidate startup/application acceptance still requires a separate
owner-authorized temporary run; a bounded candidate archive/probe is prepared in ignored local
state and has not been executed on the Pi.

The [actual package observations](evidence/sdk-20261027/official-package-observations.json) verify
all 29 sizes, digests and publisher signatures against the signed development index. They total
**25,002,414 packed bytes** and **47,453,260 unpacked bytes**. Whiteboard is the largest archive at
**15,891,385 bytes**; the official package format's existing 64 MiB bound is unchanged. These
packages use ephemeral development signatures and do not constitute production-signed artifacts.

The final full local quality gate passes **1,529 tests in 176 files**, format, lint and all
workspace types, including the measurement harness. The production build, **24 regular
foundation/official-app/SDK browser workflows** and **25 plain-HTTP workflows** pass without retries.
The current production community inspection still passes health, identity, public-key and
signed-catalog checks, with zero publishers/apps. Verified publisher identity and actual human
review remain required before any live lifecycle acceptance or production anchor pin is recorded.

## Current hosted qualification and physical Pi observation — 2026-10-27

[CI 125](https://github.com/goktugcy/everyos/actions/runs/40433524906) and
[native Linux qualification 4](https://github.com/goktugcy/everyos/actions/runs/40433524915)
completed successfully for feature head `2451554006f9aa45a14e44bc9b2c84bb54260a00`.
The SDK and official-app reports bind clean PR test merge
`1a27003c2c1679bba3d571c37d925729b636d538`, whose parents are main `006fcf6` and feature `2451554`.
Both architectures pass **1,529 tests in 176 files**, all four independent SDK templates and
**29 official artifacts / 447 app assertions**. The SDK reports and all 29 package hashes, sizes
and manifests agree across architectures.

The [CI summary](evidence/sdk-20261027/ci-125-summary.json) retains the exact browser results:
ARM64 has **95 passed**, AMD64 **94 passed plus one flaky test passed on retry**, and both regular
passes intentionally skip the one plain-HTTP-only test. Both plain-HTTP passes have **25 passed**
without skips or retries. The first AMD terminal attempt expected phase `ended` but observed
`connected` after five seconds at `tools-terminal.spec.ts:158`. A separate local setup/terminal
diagnostic passes **2/2** with retries disabled. The protected terminal source and test were unchanged;
the hosted flake's cause is not established.

The real [ARM64](evidence/sdk-20261027/sdk-linux-qualification-arm64.json) and
[AMD64](evidence/sdk-20261027/sdk-linux-qualification-amd64.json) package receipts each pass all six
published-install, authenticated-update, app-storage, backup, restore/restart and revocation scenarios.
The [native artifact provenance](evidence/sdk-20261027/native-artifact-provenance.json) records the
downloaded ZIPs verified against GitHub's SHA-256 metadata before parsing. These jobs use disposable
Ubuntu VMs and ephemeral candidate signing keys; they do not exercise production community trust.

The two real Linux browser reports each record all 29 apps and zero failed runtime requests:

| Environment                                                               | Launch range / median           | Idle renderer task-time range / median | Renderer JS heap in use      |
| ------------------------------------------------------------------------- | ------------------------------- | -------------------------------------- | ---------------------------- |
| [Linux ARM64](evidence/sdk-20261027/official-app-measurements-arm64.json) | 1,107.76–1,696.15 / 1,186.30 ms | 1.04–4.44 / 1.29%                      | 24,442,776–161,932,272 bytes |
| [Linux AMD64](evidence/sdk-20261027/official-app-measurements-amd64.json) | 1,118.38–1,698.53 / 1,597.31 ms | 0.82–6.55 / 1.24%                      | 24,404,820–145,536,748 bytes |

Both use Chromium 156.0.8078.4 on four-CPU, 16 GiB hosted Ubuntu VMs. Runtime response bodies range
from 301,088 to 1,726,950 bytes (median 325,324). As with the Mac report, the desktop renderer includes
the current app and retained allocations from earlier apps. Task time is a Chromium main-thread
measurement, not OS CPU, and heap is not RSS. Cache/collection are uncontrolled; each app has one
sequential sample. Host fixture data is explicitly simulated; the measured browser values are real.
The [ARM64](evidence/sdk-20261027/measurement-artifact-provenance-arm64.json) and
[AMD64](evidence/sdk-20261027/measurement-artifact-provenance-amd64.json) provenance receipts retain
the verified artifact digests.

### Owner-approved temporary Raspberry Pi 5 core measurement

At `2026-10-27T07:44:39Z`, the existing packaged Node **26.11.1** ran the prepared **0.1.37**
candidate as two unprivileged temporary development processes on the physical Raspberry Pi 5.
The API bound only `127.0.0.1:17740`, using a newly created private temporary directory and independent
state. The [observation](evidence/sdk-20261027/pi-candidate-observation.json) records healthy database
and connected agent after **659.01 ms**. Main-process RSS was **151,168 KiB API / 108,248 KiB agent**;
both accumulated **0.4%** of one core during the **five-second** idle sample.

This is one bounded core observation, without a browser, installation, update or production signing.
The approved archive was prepared from dirty precommit source and retains that provenance. All
**371 archived regular files** were independently byte-compared with the final local build at clean
head `2451554`; the archive was not rebuilt or relabeled as a clean package qualification.

The [cleanup receipt](evidence/sdk-20261027/pi-candidate-cleanup.json) confirms that both temporary
processes and their directory are absent, port 17740 is free, and the existing API/agent services
remain active with unchanged process identities. Installed EveryOS remains **0.1.36**. No fallback
process termination or directory removal was needed. The owner's Pi remains read-only outside this
completed exception.

The remaining integration gates are owner-verified publisher namespace/email, actual human package
review, the live production enrollment/install/update/revocation round trip, and the resulting public
community trust pin and evidence. Final protected signing, independent release verification and
explicit release approval remain separate publication gates. No main merge, tag or npm/public
EveryOS release has occurred.

## Human-reviewed live community acceptance — 2026-10-27

The owner confirmed control of the publisher identity, ran real invitation/key-proof enrollment and
submitted two actual `dev.goktugceyhan.acceptancenotes` packages. Both exact remote package hashes
and inspected manifests were compared with the retained review bytes. The owner then inspected
the packages/source and entered the digest-bound approval phrase in their own terminal. Both
server-side submissions were independently confirmed approved before the browser lifecycle began.
No production registry private key or operator token was printed or committed.

The [sanitized public receipt](evidence/community-20261027/live-lifecycle.json) records all six real
steps. At `2026-10-27T11:19:24.864Z`, a dedicated disposable EveryOS 0.1.37 instance had installed
1.0.0 from the actual public community catalog, saved a note in a real sandbox/browser and updated
to the independently approved 1.0.1 while preserving that note. The old runtime returned 404.
Only these two dedicated acceptance versions were then revoked through the publisher API. The
signed public index reached sequence **6**, retaining both revocations; syncing disabled the
installation, and new instances, both retired runtime/package paths were denied. This fixture is
a working note for acceptance, not an additional official app. Its host-data agent is explicitly
simulated; the registry, package transport, signatures, browser, SQLite storage and revocations are real.

The temporary API, agent and browser stopped, and port 17840 is free. Existing host installations
and services were not modified. Both test versions remain intentionally revoked. Production
health, identity, public key and signed-index inspection pass after this lifecycle.

`COMMUNITY_APP_REGISTRY` now pins the independently retained production public key and HTTPS index
URL. `anchors.test.ts` checks that exact endpoint/fingerprint and refuses implicit private-network
trust. The former null-anchor expectation represented the undeployed state and is replaced by
these real deployment assertions; the separate release-gate tests still reject absent anchors,
wrong/private keys, incomplete/local/expired evidence and invalid indexes. The community source
continues to default to disabled until its administrator enables it.

`packaging/community-live-acceptance.json` binds all six passed checks to this exact 0.1.37 candidate,
public-key fingerprint and immutable evidence commit `de7a4c8`. The community integration gate is
complete. The complete local gate after this pin passes format, lint, all workspace types, **1,530 tests in
176 files**, production build, **24 regular browser workflows** and **25 plain-HTTP workflows**,
with both database fixtures required and browser retries disabled. [PR #1](https://github.com/goktugcy/everyos/pull/1)
tracks the exact final-head hosted checks and merge state. No tag, npm publication or public EveryOS
release is part of these integration checks. Protected final
artifact signing, independent verification and explicit release approval remain publication gates.

### Deterministic tamper-test correction

The first full regression after the community pin reached **1,529 passed / one failed** in 176 files.
`SecretBox`'s existing tamper test sometimes changed only unused Base64url padding bits, so the
decoded authenticated bytes stayed identical and successful decryption was correct. A bounded local
reproduction found this case after 188 seals. The test now flips one decoded authentication-tag byte
and re-encodes it canonically; its rejection and wrong-key assertions remain unchanged. Production
cryptography and stored-secret compatibility are unchanged. The focused security suite passes all
13 tests. The fresh complete gate also passes all **1,530 tests in 176 files**, format/lint/all
workspace types, production build, **24 regular browser workflows** and **25 plain-HTTP workflows**
without retries. Both database fixtures are required. Fresh hosted runs are tracked by PR #1.

## 2026-10-28 community origin migration

The canonical community origin is now `https://registry.everyos.net`. Both it and the legacy
`https://everyos.goktugceyhan.dev` domain invoke the same production Worker directly. The same D1
database, private R2 bucket and independently retained Ed25519 signing key remain in use.
[Read-only migration evidence](evidence/community-20261028/origin-migration.json) verifies both
production endpoints, the canonical discovery URL, signing-key continuity and byte-identical signed
catalogs. No publisher enrollment, approval, review or revocation was performed for this migration.

The 0.1.37 lifecycle receipt retains its original origin and date and links the separate immutable
migration evidence. The gate requires complete migration checks, the exact origins, the original key
and a fresh timestamp before accepting this historical origin. The original six lifecycle checks
and candidate-version/freshness limits still apply. Published EveryOS 0.1.37 and existing publisher
credentials continue through the legacy alias; subsequent OS/CLI builds default to the new domain.

## 2026-10-28 candidate 0.1.38 live acceptance

The [fresh public receipt](evidence/community-20261028/live-lifecycle.json) records the real
0.1.38 round trip at `2026-10-28T08:15:53.435Z`. The existing owner-verified publisher submitted
new immutable versions 1.0.2 and 1.0.3. The owner reviewed their exact source and extracted
packages and entered the digest-bound approval phrase. Installation from `registry.everyos.net`,
an update preserving the saved note, and signed revocation all passed. Only those two temporary
versions were revoked; their packages and runtimes became inaccessible. Existing origin-bound
publisher credentials continued through the legacy alias. The disposable API, agent and browser
stopped and port 17840 was free afterward. No installed host services were changed.

The matching release receipt references this immutable proof. Startup now immediately refreshes
enabled app registries in the background, including after an update. Integration tests exercise
a newer signed catalog, an unavailable endpoint and an untrusted index; cached verified data,
disabled sources and installed app versions are preserved. Native package qualification also
requires the catalog to appear before any manual sync request.
