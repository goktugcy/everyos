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

The first sixteen apps were implemented and tested before the network-app handoff; the baseline
verification below records their shared gate. The table now consistently marks their development
evidence alongside the nine subsequent apps. These 25 tested apps are not a complete release.

The official registry trust anchor is pinned to the GitHub release index and the owner's public
key (see [publishing](app-sdk/publishing.md)). `anchors.test.ts` verifies the URL, fingerprint
and absent community anchor; `packages/catalogs/src/fetch.test.ts` verifies GitHub's latest →
versioned release → object redirect with public DNS pinned at every hop, credentials dropped
across origins, and private/metadata/mapped-address redirects refused. These five focused tests
passed on 2026-10-22. Publication, the complete signed catalog and the community anchor remain open.

| #   | App              | Id                        | Status |
| --- | ---------------- | ------------------------- | ------ |
| 01  | Notes            | `dev.everyos.notes`       | tested |
| 02  | Markdown Editor  | `dev.everyos.markdown`    | tested |
| 03  | Calculator       | `dev.everyos.calculator`  | tested |
| 04  | Calendar         | `dev.everyos.calendar`    | tested |
| 05  | Pomodoro         | `dev.everyos.pomodoro`    | tested |
| 06  | To-Do            | `dev.everyos.todo`        | tested |
| 07  | PDF Viewer       | `dev.everyos.pdf`         | tested |
| 08  | Text Editor      | `dev.everyos.text`        | tested |
| 09  | Whiteboard       | `dev.everyos.whiteboard`  | tested |
| 10  | Code Editor      | `dev.everyos.code`        | tested |
| 11  | JSON Studio      | `dev.everyos.json`        | tested |
| 12  | API Client       | `dev.everyos.apiclient`   | open   |
| 13  | Regex Tester     | `dev.everyos.regex`       | tested |
| 14  | SQL Client       | `dev.everyos.sql`         | open   |
| 15  | Diff Viewer      | `dev.everyos.diff`        | tested |
| 16  | Cron Builder     | `dev.everyos.cron`        | tested |
| 17  | JWT Inspector    | `dev.everyos.jwt`         | tested |
| 18  | Color Studio     | `dev.everyos.color`       | tested |
| 19  | Port Inspector   | `dev.everyos.ports`       | tested |
| 20  | DNS Lookup       | `dev.everyos.dns`         | tested |
| 21  | SSL Inspector    | `dev.everyos.ssl`         | tested |
| 22  | HTTP Monitor     | `dev.everyos.httpmonitor` | tested |
| 23  | Log Viewer       | `dev.everyos.logs`        | tested |
| 24  | Disk Explorer    | `dev.everyos.disk`        | tested |
| 25  | SSH Keys         | `dev.everyos.sshkeys`     | tested |
| 26  | Network Tools    | `dev.everyos.network`     | tested |
| 27  | Uptime           | `dev.everyos.uptime`      | tested |
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

## Remaining after the SSH Keys checkpoint — 2026-10-23

- Eight apps: API Client, SQL Client, Music Player, Video Player, Image Viewer, Gallery,
  Wallpaper Studio and Icon Studio. Their directories contain scaffolding, not completed apps.
- The all-33-app build, validate, sign and index pipeline; a machine-readable release report;
  protected `release` environment integration and the CI gate for that report. The owner's
  private signing keys remain in the protected environment.
- The community service (`services/community-registry`) using Workers, R2 and D1, its local
  tests and developer guide. The owner still supplies the domain and performs deployment;
  no account token is needed by the coding agent. Pin the community anchor after deployment.
- Synchronize and verify the existing manifest/SDK references, finish the remaining app and
  community documentation, measure Pi/amd64 package sizes, startup and resource use, and fill
  every final acceptance gate with evidence. CI already exercises official-app workflows on
  both architectures and over plain HTTP; final acceptance must cover the completed set of 33.

The Pi remains read-only. No tag, public release or main-branch merge is part of this checkpoint.
