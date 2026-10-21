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
| `create-everyos-app` creates a working app                       | open        |                                                                                                                                                                                                                                                                                 |
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
| Backup and restore compatibility                                 | open        |                                                                                                                                                                                                                                                                                 |
| Mobile and desktop interfaces                                    | open        |                                                                                                                                                                                                                                                                                 |
| Localization validation (10 languages)                           | open        |                                                                                                                                                                                                                                                                                 |
| Developer CLI                                                    | open        |                                                                                                                                                                                                                                                                                 |
| Community registry (service + client)                            | open        |                                                                                                                                                                                                                                                                                 |
| Private registry support                                         | open        |                                                                                                                                                                                                                                                                                 |
| Documentation complete                                           | open        |                                                                                                                                                                                                                                                                                 |
| No existing EveryOS functionality broken (full regression suite) | open        |                                                                                                                                                                                                                                                                                 |
| ARM64 acceptance                                                 | open        |                                                                                                                                                                                                                                                                                 |
| AMD64 acceptance                                                 | open        |                                                                                                                                                                                                                                                                                 |
| Security regression tests                                        | in progress | network policy: `desktop-apps.test.ts` › app network access (scoping, DNS rebinding, metadata, redirects, no credentials)                                                                                                                                                       |
| CI green                                                         | open        |                                                                                                                                                                                                                                                                                 |
| Release artifacts verified                                       | open        |                                                                                                                                                                                                                                                                                 |
| Release candidate prepared                                       | open        |                                                                                                                                                                                                                                                                                 |

## Official apps

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
| 20  | DNS Lookup       | `dev.everyos.dns`         | open   |
| 21  | SSL Inspector    | `dev.everyos.ssl`         | open   |
| 22  | HTTP Monitor     | `dev.everyos.httpmonitor` | open   |
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
