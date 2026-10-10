# Third-party app catalog formats: reference for Otuken catalog adapters

Status: research reference, verified against upstream on **2026-10-10**.
Audience: people implementing Otuken catalog adapters (TypeScript/Node, Docker Compose deployment).

Everything below was checked against the upstream repositories and published artifacts listed in
[Sources](#14-sources). Numbers come from scripts that parse the downloaded archives (they never execute
them). When something could not be verified, the text says so.

## 0. Snapshot and method

| Catalog | Repository / branch | Commit analysed | Commit date |
|---|---|---|---|
| CasaOS / ZimaOS official store (source) | `IceWhaleTech/CasaOS-AppStore` @ `main` | `1f4b5dea989e` | 2026-10-10 |
| same, published v2 build | `IceWhaleTech/CasaOS-AppStore` @ `gh-pages` | `e7141dfea0af` | 2026-09-24 |
| Big Bear CasaOS store | `bigbeartechworld/big-bear-casaos` @ `master` | `e6dfca559fa4` | 2026-10-10 |
| Runtipi app store | `runtipi/runtipi-appstore` @ `master` | `f3960d7c9fcf` | 2026-10-09 |
| Runtipi core (used to confirm runtime behaviour) | `runtipi/runtipi` @ `develop` | `bd98aed8e806` | 2026-09-12 |
| Coolify (service templates) | `coollabsio/coolify` @ `main` | `f55efc859dfc` | 2026-10-09 |
| CasaOS-AppManagement (CasaOS client) | `IceWhaleTech/CasaOS-AppManagement` @ `main` | `debfa317f0f9` | 2025-04-16 |
| Umbrel app store | `getumbrel/umbrel-apps` @ `master` | `aa3c4e9fba03` | 2026-10-08 |
| Portainer templates | `portainer/templates` @ `v3` (and `master`) | `47de6f5aac18` (v3), `d4116b4dabe3` (master) | 2026-10-08 (v3) |

How the data was collected:
- Archives were downloaded from `https://github.com/<owner>/<repo>/archive/refs/heads/<branch>.tar.gz`
  into a scratch directory and parsed with Python 3 + PyYAML. Nothing from the catalogs was executed.
- Published artifacts were fetched over HTTP: CasaOS/Big Bear v2 `store.json`/`index.json`, the CasaOS v1
  `main.zip`, Coolify's CDN `service-templates-latest.json`, Portainer `v3/templates.json`, and the Runtipi
  JSON schema.
- Client behaviour (how each product downloads and interprets its catalog) was read from the product
  source code: CasaOS-AppManagement (Go), Runtipi backend (TypeScript), Coolify (PHP), and IceWhale's
  `build-appstore-action` (Python).

---

## 1. Executive summary

| | CasaOS / ZimaOS official | Big Bear (CasaOS 3rd-party) | Runtipi | Coolify | Portainer | Umbrel |
|---|---|---|---|---|---|---|
| Apps (source) | 179 | 466 | 270 | 386 files, 359 published | 70 (v3) | 393 |
| Unit of definition | `Apps/<Dir>/docker-compose.yml` + `x-casaos` | same + `Apps/<dir>/config.json` | `apps/<id>/config.json` + compose (3 variants) | `templates/compose/<slug>.yaml` + `#` header comments | one JSON file with all templates | `<id>/umbrel-app.yml` + `docker-compose.yml` |
| Consumed by product as | v1: zip of repo subset. v2: static `store.json` → `index.json` → per-app files | v1: GitHub branch zip. v2: same as official (stale, see §4) | `git clone --depth 1` | CDN JSON, compose stored base64 | JSON URL | git repo (client not verified) |
| Arch declaration | `x-casaos.architectures` (all apps) | same (all apps) | `supported_architectures` (all apps) | `# amd_only` / `# arm_only` (1 app) | none (only `platform: linux/windows`) | none in manifest |
| Repo license | Apache-2.0 | MIT | **GPL-3.0** | Apache-2.0 | **no LICENSE file** | **no LICENSE file** (umbrelOS is PolyForm Noncommercial) |
| Images pinned by digest | 3.2% of image refs | 95.6% | 0% | 0% | n/a | 100% |
| Apps with ≥1 high-risk setting (definition in §8) | 17.9% | 16.1% | 17.4% | 8.6% | n/a | 9.2% |

Things that are likely to surprise you:
1. **The official CasaOS-AppStore repo is now "the ZimaOS AppStore".** Its `store-config.json` has
   `store_id: "zimaos-appstore"`, and it ships a new static **v2 protocol**: `store.json`, `index.json` with a
   per-app `content_hash`, per-architecture compose files pinned to image digests, and `meta.json` per
   locale. The legacy v1 zip is still built for CasaOS.
2. **ZimaOS's new App Store UI reportedly accepts only v2 `store.json` URLs.** A third-party maintainer
   reports that it rejects zip URLs with "Unsupported import method" (ZimaOS v1.7.0-beta1). The ZimaOS
   client is not open source, so we could not verify this ourselves.
3. **Runtipi has three compose formats in the same repo:**
   - a legacy static `docker-compose.yml` (still present in 250 apps but ignored by the current backend);
   - `docker-compose.json` with "dynamic compose" `schemaVersion: 2` (250 apps);
   - a newer native `docker-compose.yml` with an `x-runtipi` extension (20 apps).

   The current backend prefers the native file and falls back to the JSON file.
4. **Coolify templates are not plain compose files.** They depend on "magic" `SERVICE_*` variables that
   Coolify fills in at deploy time (random passwords, generated FQDNs) and on non-standard keys such as
   `volumes[].content`. The header metadata is parsed from **any** `# key: value` comment line in the
   file, not only the header.
5. **Arch declarations disagree in both directions.**
   - In a sample of 25 Big Bear apps that declare `arm64`, 2 have amd64-only main images.
   - 7 of 16 checkable Runtipi "amd64-only" apps actually have arm64 main images.
   - 23 of 23 resolvable Coolify templates (which declare nothing) have multi-arch main images.
6. **Licensing:** Runtipi's catalog is GPL-3.0. Umbrel's and Portainer's template repos have no license
   file at all.

---

## 2. CasaOS / ZimaOS official app store (`IceWhaleTech/CasaOS-AppStore`)

### 2.1 Repository, branches, distribution

- Repo: `https://github.com/IceWhaleTech/CasaOS-AppStore`. Default branch `main` holds the source.
  The `gh-pages` branch holds the generated build output.
- `README.md` line 1 reads "ZimaOS AppStore Source", and the repo hosts "the source definitions for the
  official ZimaOS app store". The CI builds two outputs from one source tree
  (`docs/migration/overview.md`, `.github/workflows/release-store.yml`):

| Output | Published at | Consumer |
|---|---|---|
| **v2 static protocol** (`dist/`) | `https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@gh-pages/store.json`, and the same tree at `https://casaos.app/store.json` (the gh-pages branch has `CNAME = casaos.app`) | ZimaOS (per the store docs) |
| **v1 legacy zip** | `https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@gh-pages/store/main.zip` (1.5 MB) | CasaOS (`CasaOS-AppManagement`) |
| Raw source archive | `https://github.com/IceWhaleTech/CasaOS-AppStore/archive/refs/heads/main.{zip,tar.gz}` (302 → `codeload.github.com`) | not used by products; **247 MB** because screenshots are included |

- `gh-pages` is only rebuilt on `v*` tags. The workflow purges the jsDelivr cache after each deploy. On
  2026-10-10, `main` was at 2026-10-10 but `gh-pages` was at 2026-09-24, and published versions lag the
  source. Example: Jellyfin's published `meta.json` says `10.11.10`, while the source says `12.2.0`.
- **How CasaOS syncs** (`CasaOS-AppManagement/service/appstore.go`, `UpdateCatalog` and `BuildCatalog`):
  1. It sends an HTTP `HEAD` to the store URL and skips the update if `Content-Length` is unchanged.
  2. Otherwise it downloads and extracts the archive into a temp directory and swaps it in atomically
     under `/var/lib/casaos/appstore/<derived>`.
  3. It locates a directory named `Apps` anywhere in the extracted tree (`StoreRoot`, a `WalkDir`; if
     there are several, the last one visited wins). Then, for each sub-directory, it loads
     `docker-compose.yml` (falling back to `.yaml`) via `compose-go`.
  4. It also reads `category-list.json` and `recommend-list.json` from the store root.

  The catalog map key is the compose top-level `name`. Invalid apps are skipped. The default config
  (`build/sysroot/etc/casaos/app-management.conf.sample`) has two `appstore =` lines: the official v1
  `main.zip` above and `https://github.com/bigbeartechworld/big-bear-casaos/archive/refs/heads/master.zip`.
- **How ZimaOS syncs (v2)**, per `docs/specs/build-output.md`:
  1. Fetch `store.json`, then `index.json`.
  2. For each app whose `content_hash` changed, fetch `compose_url` and `meta_url`.

  `metadata.tar.gz` (1.4 MB, all JSON/YAML of the build) plus `metadata.sha256` are also published at the
  gh-pages root. This is the cheapest complete snapshot for an importer.
- jsDelivr refuses directory listings of this package ("Package size exceeded the configured limit of 50
  MB"). Use `index.json`, the GitHub tree API, or `metadata.tar.gz` instead.

### 2.2 Layout

```text
CasaOS-AppStore/                     (source, branch main)
├── Apps/<Dir>/                      179 dirs; <Dir> is NOT the identity (x-casaos.id is)
│   ├── docker-compose.yml           always
│   ├── icon.svg / icon.png          176 png, 171 svg
│   ├── thumbnail.png|jpg            optional (typos exist: thimbnail.png, thumbnaill.jpg)
│   ├── screenshot-<n>.png|jpg|webp|gif
│   └── changelog.txt                rare (5)
├── store-config.json                v2 store identity (version: 2, store_id: "zimaos-appstore")
├── supported-languages.json         28 locale candidates (ll_CC)
├── category-list.json               9 categories {name, font, description} (v1 + v2)
├── recommend-list.json, featured-apps.json   [{ "appid": "<compose name>" }] (v1)
├── build/scripts/setup/script.d/99-setup-appstore.sh   shell script shipped inside v1 zip
└── docs/specs/*.md                  protocol docs (authoritative for v2)

gh-pages (v2 build output)
├── store.json, store.<locale>.json
├── index.json, index.<locale>.json
├── apps/<x-casaos.id>/docker-compose.yml
├── apps/<x-casaos.id>/docker-compose.amd64.yml | .arm64.yml   (digest-pinned per arch)
├── apps/<x-casaos.id>/meta.json, meta.<locale>.json
├── apps/<x-casaos.id>/assets/{icon.svg,icon.png,thumbnail.webp,screenshot-N.webp}
├── metadata.tar.gz, metadata.sha256
└── store/main.zip                   v1 artifact: build/sysroot/var/lib/casaos/appstore/default.new/Apps/...
```

### 2.3 Manifest schema: top-level `x-casaos` (source)

The field table follows `docs/specs/compose-and-x-casaos.md`. The "present" column is what we observed
across the 179 source apps.

| Field | Type | Required | Localized | Present | Meaning / notes |
|---|---|---|---|---|---|
| `id` | string | yes (v2) | no | 179 | Reverse-DNS app identity; `[A-Za-z0-9._-]`, ≥2 dot segments, lower-cased by the build. Prefixes seen: `org.icewhale.` (174), plus `com.icewhale.`, `org.clumoove.`, `io.github.samtv12345.`, `com.snapotter.`, `com.nzbfast.` |
| `main` | string | yes | no | 170 | Service providing the web UI |
| `index` | string | "yes in practice" | no | 136 | URL path appended to the entry URL, usually `/` |
| `port_map` | string | yes | no | 173 | Published web-UI port; must be a quoted string |
| `scheme` | `http`\|`https` | no | no | 95 | Default `http` |
| `icon` | string (URL) | yes | no | 179 | Source uses jsDelivr `@main` URLs; the build rewrites it to `apps/<id>/assets/icon.*` |
| `title` | map locale→string | yes | yes | 179 | Stays in the built compose |
| `tagline` | map | recommended | yes | 176 | |
| `description` | map | recommended | yes | 176 | May contain Markdown |
| `thumbnail` | string | no | no | 126 | |
| `screenshot_link` | string[] | no | no | 172 | |
| `tips` | object | no | values localized | 104 | `before_install: {locale: text}` (62 apps), optional `custom: string` (client schema) |
| `author` | string | recommended | no | 174 | Packager, e.g. "ZimaOS Team" |
| `developer` | string | recommended | no | 168 | Upstream project |
| `category` | enum string | yes | no | 179 | `Media, Productivity, Home, Networking, AI, Finance, Social, Developer, Others` |
| `architectures` | string[] | recommended | no | 179 | See §2.7 |
| `version` | string | yes (v2) | no | 179 | Should be semver; a non-semver value is dropped from `index.json` |
| `update_at` | string `YYYY-MM-DD` | no | no | 179 | |
| `release_notes` | map | no | yes | 179 | Becomes `release_note` in `meta.json` |
| `website`, `repo`, `support`, `docs` | string URL | no | no | 179/178/178/179 | |
| `store_app_id` | string | legacy | no | 32 | Present in the CasaOS client schema (`ComposeAppStoreInfo`), not in the v2 spec |
| `hostname` | string | legacy | no | 8 | Present in the client schema |

**Legacy service-level `services.<svc>.x-casaos`** (145 of 179 official apps; all 466 Big Bear apps) has
`envs[]`, `ports[]`, `volumes[]` and `devices[]`. Each item is `{container, description: {locale: text}}`.
The CasaOS client uses these to label user-editable fields. The v2 build **removes** them. An importer
should still read them from the source because they are the only "this field is user-facing" hint.

Malformed data seen in the source: one app has locale keys (`en_US`, `zh_CN`, …) directly under
`x-casaos`; one has `envs/ports/volumes` at the top level; one has a `screenshot` typo. Locale keys
`en_UK` (2 apps) and `de` (1 app) are invalid.

### 2.4 Example (`Apps/Jellyfin/docker-compose.yml` @ `main`; lines copied verbatim, unrelated lines omitted)

```yaml
name: jellyfin
services:
  jellyfin:
    devices:
      - /dev/dri:/dev/dri
    environment:
      PGID: $PGID
      PUID: $PUID
      TZ: $TZ
    image: linuxserver/jellyfin:12.2ubu2604-ls53
    network_mode: bridge
    ports:
      - target: 8096
        published: "8097"
        protocol: tcp
    restart: unless-stopped
    volumes:
      - type: bind
        source: /DATA/AppData/$AppID/config
        target: /config
    x-casaos:
      envs:
        - container: TZ
          description:
            en_US: TimeZone
            zh_CN: 时区
    container_name: jellyfin
x-casaos:
  id: org.icewhale.jellyfin
  architectures:
    - amd64
    - arm64
  main: jellyfin
  author: ZimaOS Team
  category: Media
  developer: Jellyfin
  icon: https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@main/Apps/Jellyfin/icon.svg
  index: /
  port_map: "8097"
  version: "12.2.0"
  update_at: "2026-10-09"
```

### 2.5 v2 build output (what ZimaOS consumes)

- **`store.json`**: `{version: 2, store_id, name, description, maintainer, url, icon?}`. Names and
  descriptions are resolved to plain strings, with one localized file per explicitly defined locale.
- **`index.json`**: `{version, updated_at, app_count, base_url, apps[]}`. Each app entry has
  `id, title, tagline, category, categories[] (lower-case), author, developer, architectures[], icon,
  thumbnail, compose_url, meta_url, content_hash (8 hex chars), version?`. Paths are relative to
  `base_url`.
- **`meta.json`**: tagline, description, screenshots, tips, attribution, architectures, version,
  `update_at`, `release_note`, website/repo/support/docs.
  - It **also contains `title`**. The spec says `title` is not written there.
  - It also contains undocumented fields: `base_url`, `id`, `categories`, `min_memory` (bytes, derived from
    `deploy.resources.reservations.memory`) and `min_image_size` (`{arch: bytes}`).
- **Built compose:**
  - Metadata is removed from `x-casaos`; only `id, main, index, port_map, scheme, icon, title` remain.
  - `docker-compose.<arch>.yml` is emitted for `amd64` and `arm64` only (178 and 152 files respectively;
    no `arm`/`386` variants, even though 42 apps declare `arm`). In these per-arch files each tagged
    image is rewritten to `<image>:<tag>@sha256:<digest>`. The default `docker-compose.yml` keeps the
    plain tag.
  - `build-appstore-action` resolves each image's per-platform digest. It **fails the build when a
    declared architecture is not provided by the image** (`ArchitectureMismatchError`), so the published
    v2 arch claims are registry-verified.
  - Pinning is best effort. On registry rate limits or resolution errors the builder keeps the tag and
    only logs a warning, and untagged images are skipped. In a random sample of 25 published per-arch
    files, every image reference was digest-pinned.

### 2.6 Variable substitution (CasaOS client)

The CasaOS client interpolates compose with `compose-go`
(`service/compose_service.go: baseInterpolationMap`, `service/compose_app.go`).

| Variable | Value | Used by apps (official / Big Bear) |
|---|---|---|
| `$AppID` | the compose app name (project name) | 123 / 238 (as `/DATA/AppData/$AppID/...`) |
| `$PUID`, `$PGID` | `"1000"` (`common.DefaultPUID/PGID`) | 40 / 189 |
| `$TZ` | host system time zone | 58 / 192 |
| `$DefaultUserName`, `$DefaultPassword` | `admin` / `casaos` | 0 / 0 |
| `$WEBUI_PORT` | a random free TCP port, chosen once per YAML load | 0 / 0 |
| any other `$VAR` | **looked up in the AppManagement process environment**, else left as literal `$VAR` | a few (e.g. `$OPENAI_ACCESS_TOKEN`) |

Path conventions (not variables): `/DATA/AppData/<app>/...` holds app state and `/DATA/Media`,
`/DATA/Downloads`, … hold user data. Many apps hard-code the folder instead of using `$AppID`. 35 official
and 195 Big Bear apps use `/DATA/AppData/<literal>/` only, for example `/DATA/AppData/bazarr`. **Otuken
must rewrite every `/DATA/...` prefix to its own data roots.** The v2 build does not substitute anything; the
substitution happens in the client at install time.

The CasaOS client also strips `runtime: nvidia` when no NVIDIA GPU is detected
(`RemoveRuntimeIfNoNvidiaGPUFlag`).

### 2.7 Architectures, ports, volumes, environment, dependencies, health checks, assets

- **Architectures:**
  - Observed values: `amd64` (179), `arm64` (152), `arm` (42), `386` (7), `ppc64le` (3), `s390x` (2).
  - The client filters the catalog by `runtime.GOARCH` of the AppManagement binary
    (`pkg/utils/cpu.go`) and treats an empty list as "all" (`route/v2/appstore.go`).
  - The v2 builder maps `arm` to `linux/arm` with no variant.
- **Ports:** standard compose. The official store mostly uses long syntax with a **fixed `published`
  port** (e.g. Jellyfin `8097:8096`, chosen to avoid clashes). `port_map` names the web port.
  `network_mode: bridge` is written explicitly in 99 apps.
- **Volumes:** absolute bind mounts. 123 apps use `/DATA/AppData/$AppID/...`; 39 more use `/DATA/...`
  without `$AppID` (35 of them use a literal `/DATA/AppData/<name>`).
- **Environment:** plain compose `environment`. There are no required/secret/default flags. Credentials
  are frequently hard-coded: 41 of 179 apps (22.9%) contain a literal value for a password/secret-like
  key (heuristic, §8.6).
- **Dependencies:** compose `depends_on` only. There are no inter-app dependencies.
- **Health checks:** 19 of 179 apps define a compose `healthcheck`. The CasaOS client also does an HTTP
  GET to the web port and treats 200 or 401 as healthy (`compose_app.go`).
- **Icons and screenshots:** URLs in source (jsDelivr `@main`). In v2 they are relative asset paths:
  SVG icons are kept and get a PNG fallback; other images are converted to WebP.
- `container_name` is fixed in 171 of 179 apps (95.5%), which collides if two catalogs install the same
  app on one host.

### 2.8 Localization

- Locale maps are keyed `ll_CC`. App fields: `title`, `tagline`, `description`, `release_notes`, and
  values under `tips`.
- Coverage (apps defining at least one of title/tagline/description in that locale): en_US 179,
  zh_CN 169, de_DE and fr_FR 130 each, it_IT and ru_RU 128 each, sv_SE 125, ja_JP 78; 13 other locales
  54–75 each.
- `title` often has only `en_US`.
- Fallback rule used by the build: the default output is always generated, and a locale file is emitted
  only when that locale is explicitly present.

### 2.9 License

`LICENSE` is **Apache License 2.0**.
- Importing and redistributing the compose files and texts is permitted with attribution and the license
  notice (keep `NOTICE` if present; none was found).
- Icons, screenshots and logos are third-party trademarks or artwork. Apache-2.0 on the repo does not
  grant trademark rights (Apache-2.0 §6).
- Fetching at runtime on the user's machine raises no redistribution question. Bundling a snapshot in
  Otuken releases requires preserving the license text.

### 2.10 Versioning

| Identifier | Meaning |
|---|---|
| Commit SHA | Source of truth. GitHub `tar.gz` archives carry it in the pax global header comment; `.zip` archives carry it in the zip comment (both verified). |
| `gh-pages` commit plus `index.json.updated_at` | The published build |
| `x-casaos.version` | App version |
| `content_hash` | Change detector over all generated files of one app |

`x-casaos.version` is **not** reliably equal to the image tag: in 43 of 179 apps the version string is
not a substring of the main image tag. Examples: `AnythingLLM` has version `1.14.2` with image `:latest`;
`DuckDNS` has `0.0.1` with `:latest`.

### 2.11 Gotchas

- There are two identities: the compose `name` (v1 key, `$AppID`) and `x-casaos.id` (v2 key). Jellyfin
  has `name: jellyfin` and `id: org.icewhale.jellyfin`.
- Variants of one product are separate apps (e.g. `Jellyfin` and `Jellyfin_Nvidia` (`org.icewhale.jellyfinnvidia`),
  `Ollama_Nvidia`, `Plex_Nvidia`).
- Unknown `$VARS` resolve from the host process environment in CasaOS. **Do not** replicate this:
  resolve only from an allow-list.
- The v1 zip contains a shell script (`99-setup-appstore.sh`). Never execute catalog content.
- Image tags are mostly fixed tags (86.5% of 252 refs), 10.3% are `latest` or untagged, and 3.2% are
  digests.

---

## 3. ZimaOS app store

- **Same source format, newer distribution protocol.** The official ZimaOS store *is*
  `IceWhaleTech/CasaOS-AppStore`:
  - `store-config.json` `store_id: "zimaos-appstore"`;
  - `docs/specs/*` describe the "v2 store protocol" for ZimaOS;
  - `docs/wrangler.jsonc` names the docs site `zimaos-appstore-dev-docs`.

  Source apps are standard compose with top-level `x-casaos`. The v2 protocol relative to v1 (from
  `docs/migration/overview.md`):
  - requires `x-casaos.id`, `x-casaos.version`, the 9 normalized categories, normalized `ll_CC` locale
    keys, `store-config.json` and `supported-languages.json`;
  - drops `appfile.json` and service-level `x-casaos` from the built output;
  - distributes static files with `content_hash`-based incremental updates instead of a zip.
- **ZimaOS client**: `github.com/IceWhaleTech/ZimaOS` contains only release material (README,
  `rauc.txt`, `release-note/`, …). The App Store client source is **not public**, so we could not verify
  client-side behaviour.
  - The store FAQ says ZimaOS isolates installs by store context, so identical `id`s from different
    stores do not collide.
  - Per a third-party store maintainer (README of `chicohaager/zima-appstore`, measured on ZimaOS
    v1.7.0-beta1, *not independently verified*):
    - the new UI adds sources via `POST /v3/app_store/repo` and answers HTTP 400 "Unsupported import
      method." for zip URLs;
    - the old `POST /v2/app_management/appstore?url=<zip>` still works, but the zip does not show in the
      new UI.
- **Official third-party list** (`docs/resources/recommended-third-party-stores.md`, mirrored on
  `zimaspace.com/docs/zimaos/app-store/awesome-third-party-stores`):
  - Play AppStore: `https://play.cuse.eu.org/store.json`, repo `Cp0204/CasaOS-AppStore-Play`;
  - Big Bear: `https://cdn.jsdelivr.net/gh/bigbeartechworld/big-bear-casaos@gh-pages/store.json`;
  - Lintuxer: `https://chicohaager.github.io/zima-appstore/store.json`, repo `chicohaager/zima-appstore`.

  We did not analyse Play or Lintuxer.
- **Adapter implication:** one "CasaOS-family" adapter with two input modes:
  - **source mode**: a repo or zip containing `Apps/*/docker-compose.yml`;
  - **v2 mode**: a `store.json` URL, then `index.json`, `meta.json` and per-arch compose.

  v2 mode gives registry-verified architectures and digest-pinned images for free.

---

## 4. Big Bear CasaOS (`bigbeartechworld/big-bear-casaos`) and deviations

- Repo `https://github.com/bigbeartechworld/big-bear-casaos`, default branch `master`, **MIT** license
  (`Copyright (c) 2023 Big Bear Enterprises, LLC`). 466 apps.
- Distribution:
  - **v1**: `https://github.com/bigbeartechworld/big-bear-casaos/archive/refs/heads/master.zip`
    (README; also the second default store in CasaOS-AppManagement).
  - **v2**: `store-config.json` `store_id: "com.bigbeartechworld.zimaos"`; built with
    `IceWhaleTech/build-appstore-action@v1.0.0` to `gh-pages`. **The published v2 index is stale and
    incomplete:**
    - it lists 243 of 466 apps;
    - `gh-pages` was last deployed on 2026-08-17;
    - the recent `release.yml` runs we listed (2026-10-03 to 2026-10-09) concluded `failure`;
    - none of the 243 published entries has a `version`.

    We did not investigate the cause. It is *consistent with* the v2 builder's arch-verification failure
    (see the arm64 mismatches below).
- Layout: `Apps/<dir>/docker-compose.yml` plus `Apps/<dir>/config.json`. The root `config.json` is a
  legacy `{app: version}` map. There are also `category-list.json`, `recommend-list.json`, `renovate.json`
  and an `Apps/__tests__/` directory (skip it).

How Big Bear differs from the official format:

| Aspect | Official | Big Bear |
|---|---|---|
| Per-app sidecar | none | `config.json` `{id, version, image, youtube, docs_link}`, used for Renovate/version tracking (example below) |
| `x-casaos.version` | present (179) | **absent (0/466)**; the version lives in `config.json` |
| `website`/`repo`/`docs`/`release_notes`/`update_at` | present | absent |
| compose `name` / `container_name` | `jellyfin` | `big-bear-<app>`; `container_name` fixed in 244 apps |
| Image pinning | 3.2% digest | **95.6% digest** (`tag@sha256:`) |
| Port syntax | long syntax | short syntax (`"8000:8000"`); 58 apps publish a port < 1024 |
| Locales | up to 28 | `en_US` only |
| Arch vocabulary | `arm`, `386` | `armv7` (16), `i386` (1) |
| Icons | repo assets via jsDelivr | mostly external: `cdn.jsdelivr.net/gh/selfhst/icons/...`; `thumbnail: ""` |
| Category usage | Media-heavy | `Home` (160), `Others` (143) |
| Placeholders | none | free-text `[CHANGE_TO_LAN_IP]` in env values (seen in 1 app) |
| Service-level `x-casaos` | 145/179 | 466/466, with generic text ("Container Variable: APP_URL") |

`Apps/2fauth/config.json`:

```json
{
  "id": "2fauth",
  "version": "8.0.2",
  "image": "2fauth/2fauth",
  "youtube": "https://youtu.be/yCnjxSryD_U",
  "docs_link": ""
}
```

Excerpt from `Apps/2fauth/docker-compose.yml` (comments and some keys omitted):

```yaml
name: big-bear-2fauth
services:
  app:
    container_name: big-bear-2fauth
    image: 2fauth/2fauth:8.0.2@sha256:50421b873c7e5060e2560290bee39e0ff32ffed76949cdb8c12cd76a2d85fde7
    ports:
      - "8000:8000"
    volumes:
      - /DATA/AppData/$AppID/data:/2fauth
    environment:
      - APP_URL=http://[CHANGE_TO_LAN_IP]:8000
x-casaos:
  architectures:
    - amd64
    - arm64
  id: com.bigbeartechworld.2fauth
  main: app
  category: Developer
  port_map: "8000"
```

Version reliability: in 50 of 466 apps, `config.json.version` differs from the main image tag. Examples:
`ardour` has `0.0.0` vs `version-2026-06-19`; `buzz` has `latest` vs `main`.

---

## 5. Runtipi (`runtipi/runtipi-appstore`)

### 5.1 Repository and sync

- Repo: `https://github.com/runtipi/runtipi-appstore`, default branch `master`, **GPL-3.0**. 270 apps
  (directories under `apps/` that contain `config.json`).
- The Runtipi backend clones each configured store with **isomorphic-git**: `git.clone({singleBranch:
  true, depth: 1, ref: branch})` into `<dataDir>/repos/<slug>`, then pulls it.
  - The default store URL is `https://github.com/runtipi/runtipi-appstore`
    (`common/helpers/env-helpers.ts`).
  - A branch is selected with the URL form `https://github.com/<o>/<r>/tree/<branch>`
    (`repos.helpers.ts: getRepoBaseUrlAndBranch`).
- Archive equivalent for Otuken: `https://codeload.github.com/runtipi/runtipi-appstore/tar.gz/refs/heads/master`
  (8.7 MB). Codeload responses had no `Content-Length` but did have an `ETag`.

### 5.2 Layout

```text
apps/
├── app-info-schema.json            JSON schema for config.json (lags the runtime schema; see 5.3)
├── dynamic-compose-schema.json     OLD dynamic-compose schema (env as object); the runtime uses schemas.runtipi.io/v2
├── docker-compose.common.yml       declares external network runtipi_tipi_main_network
└── <id>/
    ├── config.json                 app manifest (required)
    ├── docker-compose.json         dynamic compose schemaVersion 2 (250 apps)
    ├── docker-compose.yml          EITHER legacy static compose (250) OR native compose with x-runtipi (20)
    ├── metadata/logo.jpg           always a JPEG
    ├── metadata/description.md     long description (Markdown)
    └── data/                       optional seed files (45 apps); *.template files rendered with {{VAR}}
```

### 5.3 `config.json` schema

The runtime schema is `packages/common/src/schemas/app-info.ts` in `runtipi/runtipi`, written with
arktype. The "present" column is counts in the 270 apps.

| Field | Type / allowed | Default | Present | Meaning |
|---|---|---|---|---|
| `id` | string, no `:` | required | 270 | App id within the store; the URN is `<id>:<storeSlug>` |
| `name` | string | required | 270 | Display name |
| `available` | bool | required | 270 (all true) | |
| `deprecated` | bool | false | 7 (6 true) | |
| `port` | 1–65535 | – | 268 | Default host port for `APP_PORT` |
| `tipi_version` | number | required | 270 | **Monotonic package revision** (2 to 551). The UI shows an update when `Number(installed) < Number(latest)` (`app-actions.tsx`) |
| `version` | string | `latest` | 270 | Upstream version; exported as `APP_IMAGE_TAG` |
| `short_desc` | string | required | 270 | |
| `description` | string | `""` | 270 | The long text comes from `metadata/description.md` |
| `author` | string | required | 270 | Upstream author |
| `source` | string | required | 270 | Source repo URL |
| `website` | string | – | 113 | |
| `categories` | enum[]: `network, media, development, automation, social, utilities, photography, security, featured, books, data, music, finance, gaming, ai` | `['utilities']` | 270 | |
| `form_fields` | FormField[] | `[]` | 266 (141 non-empty) | See 5.5 |
| `supported_architectures` | `arm64`\|`amd64` | **`['amd64','arm64']`** | 270 (253 both, 17 amd64-only) | |
| `exposable`, `force_expose`, `https`, `no_gui`, `url_suffix` | bool / string | false | 266 / 7 / 5 / 27 / 7 | Reverse-proxy and UI behaviour; `url_suffix` is the entry path |
| `dynamic_config` | bool | false | 270 (all true) | Use dynamic compose |
| `min_tipi_version` | semver string | – | 270 (`4.5.0`, `4.7.0`, `4.8.0`) | |
| `uid`, `gid` | number | – | 11 | |
| `generate_vapid_keys` | bool | false | 1 | Generates `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` |
| `force_pull` | bool | false | 55 | |
| `created_at`, `updated_at` | epoch ms | 0 | 270 | |
| `requirements` | `{ports: number[]}` | – | 3 | **Not in any schema** (adguard, stalwart-mail, transmission) |

The in-repo `app-info-schema.json` declares `additionalProperties: false`, but `requirements` is present
in 3 apps anyway. Validate leniently.

### 5.4 Compose variants and backend selection

`AppStoreFilesManager.getSourceDockerComposeYaml`:
1. If `docker-compose.yml` exists **and contains top-level `x-runtipi`**, use it (native format).
2. Otherwise use `docker-compose.json` (legacy dynamic compose) and convert it with `convertLegacyToYaml`.
3. A legacy static `docker-compose.yml` without `x-runtipi` is **ignored** by current Runtipi, but it is
   still in 250 apps. In 18 of 250 apps its image set differs from the JSON. **Do not import the legacy
   YAML.**

**Dynamic compose v2** (`https://schemas.runtipi.io/v2/dynamic-compose.json`, `schemaVersion: 2`):
- Top level: `schemaVersion` (const 2), `services[]`, `overrides[]`.
- Each service has `name*` and `image*`, plus:
  - `isMain`, `internalPort`, `addPorts[{containerPort, hostPort, udp, tcp, interface}]`;
  - `environment: [{key, value}]` (an **array**; the old in-repo schema says object);
  - `volumes: [{hostPath, containerPath, readOnly, shared, private, bind.propagation}]`;
  - `command`, `entrypoint`, `healthCheck{test*, interval, timeout, retries, startPeriod, startInterval}`,
    `dependsOn` (string[] or `{svc: {condition}}`);
  - `networkMode`, `addToMainNetwork`, `extraHosts`, `dns`, `hostname`, `ulimits`, `sysctls`;
  - `capAdd`, `capDrop`, `devices`, `deploy.resources`, `pid`, `privileged`, `securityOpt`, `readOnly`;
  - `user`, `workingDir`, `shmSize`, `tty`, `stdinOpen`, `stopSignal`, `stopGracePeriod`, `logging`,
    `extraLabels`.
- `overrides: [{architecture: arm64|amd64, services: [...]}]` swaps images per architecture (3 apps, e.g.
  `apps/gotify/docker-compose.json` uses `gotify/server-arm64:2.6.3` for arm64).

**Native compose** (`packages/common/src/schemas/compose-yaml.ts`):
- Normal compose plus top-level `x-runtipi: {schema_version: 1|2, overrides?: [{architecture, services}]}`.
- Per-service `x-runtipi: {is_main?, internal_port?, add_to_main_network?}`.

What the builder does to either form:
- adds `${APP_PORT}:<internal_port>` for the main service when the user opens a port;
- adds Traefik labels when the app is exposed;
- adds an app-private network for multi-service apps and the external `runtipi_tipi_main_network`;
- adds the labels `runtipi.managed`, `runtipi.appurn`;
- sets `restart: unless-stopped` if missing;
- replaces `{{RUNTIPI_APP_ID}}` inside labels.

`apps/jellyfin/docker-compose.json` (values verbatim; PUID/PGID entries omitted, whitespace compacted):

```json
{
  "services": [
    {
      "name": "jellyfin",
      "image": "lscr.io/linuxserver/jellyfin:version-12.2ubu2604",
      "isMain": true,
      "internalPort": 8096,
      "environment": [
        { "key": "TZ", "value": "${TZ}" },
        { "key": "JELLYFIN_PublishedServerUrl", "value": "${APP_PROTOCOL:-http}://${APP_DOMAIN}/" }
      ],
      "volumes": [
        { "hostPath": "${APP_DATA_DIR}/data/config", "containerPath": "/config" },
        { "hostPath": "${ROOT_FOLDER_HOST}/media/data", "containerPath": "/media/data" }
      ]
    }
  ],
  "schemaVersion": 2,
  "$schema": "https://schemas.runtipi.io/v2/dynamic-compose.json"
}
```

`apps/beszel/docker-compose.yml` (native format, complete file):

```yaml
services:
  beszel:
    image: henrygd/beszel:0.21.0
    volumes:
      - ${APP_DATA_DIR}/data:/beszel_data
    x-runtipi:
      internal_port: 8090
      is_main: true
x-runtipi:
  schema_version: 2
```

### 5.5 Variables and `form_fields`

`AppHelpers.generateEnvFile` writes `<app-data>/app.env`. It **starts from the platform's own `.env`
map** and then adds app variables.

| Variable | Value |
|---|---|
| `APP_PORT` | user-chosen or `config.port` |
| `APP_ID` | `<appName>-<storeId>` |
| `APP_URN`, `APP_NAME`, `APP_STORE_ID` | identity |
| `APP_DATA_DIR` | `<appDataPath>/app-data/<storeId>/<appName>` |
| `ROOT_FOLDER_HOST` | host Runtipi root, used for `${ROOT_FOLDER_HOST}/media/...` |
| `APP_IMAGE_TAG` | `config.version` |
| `APP_EXPOSED` | `true`/`false` |
| `APP_HOST`, `APP_DOMAIN`, `APP_PROTOCOL` | internal IP and port, local subdomain, or the exposed domain, depending on exposure mode |
| `APP_LOCAL_DOMAIN`, `APP_EXPOSED_DOMAIN` | |
| Inherited platform vars | `TZ`, `INTERNAL_IP`, `DNS_IP`, `ARCHITECTURE`, `DOMAIN`, `LOCAL_DOMAIN`, `ROOT_FOLDER_HOST`, `RUNTIPI_APP_DATA_PATH`, `POSTGRES_HOST/DBNAME/USERNAME/PORT`, **`JWT_SECRET`**, … |

Observed usage (apps referencing the variable): `APP_DATA_DIR` 238, `TZ` 79, `APP_DOMAIN` 54,
`ROOT_FOLDER_HOST` 45, `APP_PROTOCOL` 36, `APP_PORT` 8, `INTERNAL_IP` 6, `NETWORK_INTERFACE` 3,
`TIPI_UID`/`TIPI_GID` 2.

`NETWORK_INTERFACE`, `TIPI_UID` and `TIPI_GID` were not found in the backend env builder; treat them as
unresolved.

`form_fields[]` items: `{type*, label*, env_variable*, placeholder, hint, min, max, required=false,
default, regex, pattern_error, options[{label, value}], encoding: hex|base64}`.
- Allowed `type` values (count of fields): `text` (183), `random` (137), `password` (77), `boolean` (39),
  `number` (29), `email` (10), `url` (6), `ip` (3), `fqdn` (2), `fqdnip` (1).
- `random` values are **deterministic**: `sha256(env_variable + per-install seed)`, truncated to `min`
  (default 32) hex characters, or bytes when `encoding: base64`. Existing values are kept on reinstall.
- A `required` field without a value aborts the install.

Example, `apps/fireshare/config.json` `form_fields` (values verbatim, whitespace compacted):

```json
[
  { "type": "random", "label": "FIRESHARE_SECRET_KEY", "min": 32, "env_variable": "FIRESHARE_SECRET_KEY" },
  { "type": "text", "label": "Fireshare username", "max": 50, "min": 3, "required": true, "env_variable": "FIRESHARE_USERNAME" },
  { "type": "password", "label": "Fireshare password", "max": 50, "min": 8, "required": true, "env_variable": "FIRESHARE_PASSWORD" }
]
```

`data/**/*.template` files (5 apps) are copied to `${APP_DATA_DIR}/data/` with `{{VAR}}` replaced from
the env map. Other `data/` files are copied verbatim. This only happens when the destination does not
exist yet.

### 5.6 Other representations

- **Architectures:**
  - `supported_architectures` has only two allowed values, and **missing means both**.
  - In the spot check (§8.5), all 25 sampled arm64 claims were correct.
  - 7 of 16 checkable amd64-only claims were under-declared: the main image has arm64 (for example
    `guacamole/guacamole:1.6.0`, `lukevella/rallly:4.15.4`). Sidecars may be the reason; we checked only
    the main image.
- **Icons:** `metadata/logo.jpg` (falls back to a default logo). There are no screenshots in the repo.
- **Localization:** none in the catalog. All text is English.
- **Health checks:** 37 of 270 apps define one.
- **Dependencies:** service-level `dependsOn` only.
- **Fixed published ports:** only via `addPorts` or `APP_PORT`. `requirements.ports` hints at host ports
  that must be free.

### 5.7 License

`LICENSE` is **GNU GPL v3**. This is not legal advice; practical reading:
- Fetching the catalog at runtime on the user's machine and generating compose from it locally does not
  distribute it, so there is no conflict.
- **Bundling or redistributing** Runtipi catalog content inside Otuken artifacts (release tarballs,
  prebuilt indexes, a hosted mirror) should be treated as distributing GPL-3.0 material. Keep it as a
  separately licensed data package (GPL-3.0, with source and attribution), or avoid bundling it.
- Do not copy the content into Otuken's own (differently licensed) code tree.

### 5.8 Versioning and gotchas

- Use the commit SHA plus `tipi_version` (package revision). `version` is the upstream version, and it
  differs from the main image tag in 27 of 250 apps (examples: `bitcoind` `28.0` vs `v28.0`; `crowdsec`
  `v1.7.8` vs `latest`; `electrs` `v0.12.0` vs `v0.9.2`).
- Image refs: 88.4% fixed tags, 11.6% `latest` or untagged, and **0 digests**.
- `container_name` is never set (the builder relies on the project name). 29.6% of apps are multi-service.
- Platform secrets leak into app env in Runtipi's design (the base `.env` includes `JWT_SECRET`). Otuken
  must not copy this; provide an explicit allow-list of platform variables instead.
- `${ROOT_FOLDER_HOST}/media/...` hard-codes Runtipi's directory layout. Map it to Otuken's shared media
  root.

---

## 6. Coolify service templates (`coollabsio/coolify`)

### 6.1 Repository and distribution

- Repo: `https://github.com/coollabsio/coolify`, branch `main`, **Apache-2.0**. Templates live in
  `templates/compose/*.yaml|*.yml` (386 files: 382 `.yaml`, 4 `.yml`). 27 are marked `# ignore: true`,
  leaving **359 published**.
- Generated by `php artisan generate:services` (`app/Console/Commands/Generate/Services.php`):
  - `templates/service-templates-latest.json` is the current format.
  - `templates/service-templates.json` is the legacy format: the same content with `SERVICE_URL_*`
    rewritten to `SERVICE_FQDN_*` for older Coolify versions.
- **The product fetches** `https://cdn.coollabs.io/coolify/service-templates-latest.json`
  (`config/constants.php` → `services.official`) with 3 retries and a 60 s timeout, and caches it in the
  Laravel cache (Redis by default).
  - The CDN file had the same 359 keys as the repo file on 2026-10-10. It is about 1.1 MB.
- Logos: `public/svgs/<file>` (349 files). Fetchable at
  `https://raw.githubusercontent.com/coollabsio/coolify/main/public/svgs/<file>` (verified with HTTP 200).
- Cheapest import: the CDN JSON (self-contained: metadata plus base64 compose). For pinning to a commit,
  use the repo archive (18.7 MB tar.gz) and read `templates/`.

### 6.2 Header metadata

The generator matches `preg_match('/^#(?<key>.*):(?<value>.*)$/U', $line)` on **every line of the file**.
Any `# Something: text` comment, even one deep inside the compose body, becomes a metadata key; later
lines override earlier ones. We observed junk keys such as `IMPORTANT`, `Option 1` and
`- CAP_AWS_ACCESS_KEY`.

| Header key | Present (of 359) | Output JSON field / behaviour |
|---|---|---|
| `documentation` | 356 | `documentation` with `?utm_source=coolify.io` **blindly appended**, which produces `...?tab=readme-ov-file?utm_source=coolify.io`; default `https://coolify.io/docs` |
| `slogan` | 356 | `slogan`; default is the headline-cased file name |
| `category` | 355 | free-form, inconsistent case: `productivity` 72, `media` 27, `ai` 25, `devtools` 25, `RSS` 7, `Mail` 2, `database,observability,developer-tools` 1, … |
| `tags` | 354 | lower-cased, comma-split; `null` if empty |
| `logo` | 350 | path under `public/`, default `svgs/default.webp` |
| `port` | 342 (JSON) | main HTTP port (string) |
| `minversion` | 1 | default `0.0.0` |
| `env_file` | – | base64 of a sibling env file → `envs` |
| `amd_only` / `arm_only` | 1 / 0 | booleans |
| `ignore` | 27 | excluded from the JSON |
| (computed) | – | `template_last_updated_at` = `git log -1 --format=%cI` of the file; `compose` = base64 of a YAML re-dump |

JSON entry (`service-templates-latest.json` → `"uptime-kuma"`; `compose` truncated):

```json
{
  "documentation": "https://github.com/louislam/uptime-kuma?tab=readme-ov-file?utm_source=coolify.io",
  "slogan": "Uptime Kuma is a monitoring tool for tracking the status and performance of your applications in real-time.",
  "compose": "c2VydmljZXM6CiAgdXB0aW1lLWt1bWE6CiAgICBpbWFnZTogJ2xvdWlzbGFt...",
  "tags": ["monitoring", "status", "performance", "web", "services", "applications", "real-time"],
  "category": "monitoring",
  "logo": "svgs/uptime-kuma.svg",
  "minversion": "0.0.0",
  "template_last_updated_at": "2026-01-08T21:10:17+01:00",
  "port": "3001"
}
```

Source file `templates/compose/uptime-kuma.yaml` (complete):

```yaml
# documentation: https://github.com/louislam/uptime-kuma?tab=readme-ov-file
# slogan: Uptime Kuma is a monitoring tool for tracking the status and performance of your applications in real-time.
# category: monitoring
# tags: monitoring, status, performance, web, services, applications, real-time
# logo: svgs/uptime-kuma.svg
# port: 3001

services:
  uptime-kuma:
    image: louislam/uptime-kuma:2
    environment:
      - SERVICE_URL_UPTIMEKUMA_3001
    volumes:
      - uptime-kuma-data:/app/data
    healthcheck:
      test: ["CMD-SHELL", "extra/healthcheck"]
      interval: 5s
      timeout: 5s
      retries: 10
```

### 6.3 Magic environment variables

These are implemented in `bootstrap/helpers/shared.php` (`parseCommandFromMagicEnvVariable`,
`generateEnvValue`) and `bootstrap/helpers/parsers.php`. A variable is "magic" when its name starts with
`SERVICE_`. It may appear as a bare list item (`- SERVICE_URL_APP_3000`) or be referenced in a value
(`${SERVICE_PASSWORD_POSTGRES}`).

| Pattern | Generated value |
|---|---|
| `SERVICE_URL_<NAME>[_<PORT>]` | Full URL with scheme for the service, generated from the server's wildcard domain (`<name>-<uuid>.<wildcard>`) or user-set. A trailing numeric `_<PORT>` means "proxy this port". A value starting with `/` is appended as a path. |
| `SERVICE_FQDN_<NAME>[_<PORT>]` | **Host only, without scheme** (the comments in current code say so explicitly), with `:port` in the `_PORT` form. The URL and FQDN pairs are always created together. |
| `SERVICE_USER_<NAME>` | `Str::random(16)` |
| `SERVICE_LOWERCASEUSER_<NAME>` | lowercase random(16) |
| `SERVICE_PASSWORD_<NAME>` / `SERVICE_PASSWORD_64_<NAME>` | `Str::password()` (32) / length 64, no symbols |
| `SERVICE_PASSWORDWITHSYMBOLS[_64]_<NAME>` | password with symbols |
| `SERVICE_BASE64[_32\|_64\|_128]_<NAME>` | **not base64**: `Str::random(32/64/128)` |
| `SERVICE_REALBASE64[_32\|_64\|_128]_<NAME>` | `base64(random_bytes(n))` |
| `SERVICE_HEX_32\|_64\|_128_<NAME>` | `bin2hex(random_bytes(n/2))` (32/64/128 hex chars) |
| `SERVICE_SUPABASEANON_<NAME>`, `SERVICE_SUPABASESERVICE_<NAME>` | HS256 JWT signed with `SERVICE_PASSWORD_JWT`, role `anon` / `service_role` |
| `COOLIFY_RESOURCE_UUID`, `COOLIFY_CONTAINER_NAME`, `COOLIFY_URL`, `COOLIFY_FQDN`, `COOLIFY_BRANCH` | injected by Coolify |

Template usage counts (occurrences): `SERVICE_PASSWORD_` 925, `SERVICE_URL_` 630, `SERVICE_USER_` 501,
`SERVICE_BASE64_` 67, `SERVICE_FQDN_` 50, `SERVICE_REALBASE64_` 20, `SERVICE_HEX_` 16.

Parsing gotchas:
- The command is derived by counting underscores. Two underscores means `SERVICE_<CMD>_<NAME>`; three
  means `_<CMD>_<N>_<NAME>`, or `<NAME>_<PORT>` for URL/FQDN.
- So a `<NAME>` that contains `_` is mis-parsed. For example, `SERVICE_PASSWORD_MY_DB` yields the command
  `PASSWORD_MY`, which is unknown and generates `null`.
- Plain `${VAR:-default}` variables are user-editable env vars with defaults.

### 6.4 Coolify-specific compose extensions

- `volumes[]` long syntax with `type: bind` plus **`content: |`** creates a file with that content at
  `source` (34 templates). `is_directory: true` creates a directory (5 templates). Example:
  `templates/compose/filebrowser.yaml` writes `./filebrowser.json`.
- Service-level `exclude_from_hc: true` excludes the service from aggregated health status (13 templates).
- Relative bind sources (`./x`) resolve inside Coolify's per-service directory.
- **YAML merge keys:** 2 templates (`gramps-web`, `langfuse`) use `<<: *anchor` with a sequence anchor.
  PyYAML (and probably strict YAML 1.2 parsers) reject this; Symfony YAML accepts it. The published JSON
  contains a re-dumped, merge-resolved compose. We parsed those two via the JSON.

### 6.5 Architecture, health, dependencies, license, versioning

- **Architecture:** effectively undeclared. One template has `amd_only`. Spot check: all 23 resolvable
  sampled main images were multi-arch (amd64+arm64).
- **Health checks:** strongest of all catalogs. 334 of 359 apps have at least one service with a
  healthcheck, and 299 have one on all services. Multi-service apps: 52.6%.
- **Images:** 67.2% fixed tag, **29.9% `latest` or untagged**, 2.8% variable tags such as
  `${IMMICH_VERSION:-release}`, and 0 digests.
- **License:** Apache-2.0 for templates and generator. Logos in `public/svgs` are third-party marks.
- **Versioning:** commit SHA. `template_last_updated_at` changes per file. There is no app version
  field; derive versions from image tags.

---

## 7. Brief: Portainer and Umbrel

### 7.1 Portainer app templates

- **URL:** `DefaultTemplatesURL = https://raw.githubusercontent.com/portainer/templates/v3/templates.json`
  (`portainer/portainer` `api/portainer.go`). The v2-format file is at `master/templates-2.0.json`; the
  README says "use the `master` branch" for version 2.
- **Format** (one JSON file): `{version: "3"|"2", templates: [...]}`.
  - `type`: 1 = container, 2 = Swarm stack, 3 = Compose stack (per Portainer docs).
  - Container fields: `title, description, categories[], platform (linux|windows), logo, image,
    ports["5000/tcp"], volumes[{container, bind?, readonly?}], env[{name, label, description, default,
    preset, select[{text, value, default}]}], command, privileged, interactive, restart_policy,
    hostname, labels, note, name, registry, administrator_only`.
  - Stack fields: `repository{url, stackfile}`, which points at a compose file in a git repo.
  - **v3 differences observed:** every template has an integer `id`, and `version: "3"`.
    `templates-2.0.json` additionally contains `type: 4` (7 entries) and a top-level `stackfile` key; the
    meaning of type 4 was not verified.
- **Counts:** v3 has 70 templates (37 container, 12 swarm, 21 compose). `master/templates-2.0.json` has 68.
- **License:** **no LICENSE file** on `master` or `v3` (HTTP 404), and the GitHub API reports none.
  Treat the content as "all rights reserved". Fetching it at runtime on the user's machine is the safe
  mode. Do not mirror or bundle it.
- **Adapter value:** low. The catalog is small, has no architecture data or versioning, and stack
  templates require a second fetch.

### 7.2 Umbrel (`getumbrel/umbrel-apps`)

- **Layout:** `<id>/umbrel-app.yml` + `<id>/docker-compose.yml`, plus optional shell scripts
  (`exports.sh` in 74 apps, `entrypoint.sh` in 8), `torrc.template`, `settings.env`. 393 apps.
- **`umbrel-app.yml` keys present in all 393 apps:** `manifestVersion`, `id`, `category`, `name`,
  `version`, `tagline`, `description`, `developer`, `website`, `dependencies` (other app ids), `repo`,
  `support`, `port`, `gallery` (file names only; the images are not in this repo), `path`, `submitter`,
  `submission`. Optional keys (apps): `releaseNotes` 392, `defaultUsername` 308, `defaultPassword` 269,
  `storage` 222, `deterministicPassword` 95, `torOnly` 75, `permissions` 42, `backupIgnore` 36,
  `disabled` 25, `widgets` 14, `folderAccess` 5, `implements` 4, `requiresHttps` 3.
- **Compose conventions:**
  - an `app_proxy` service with `APP_HOST: <app>_<service>_1` and `APP_PORT`;
  - variables `${APP_DATA_DIR}` (349), `${APP_PASSWORD}`, `${APP_SEED}`, `${DEVICE_DOMAIN_NAME}`,
    `${UMBREL_ROOT}`, and Bitcoin/Lightning/Tor variables;
  - **100% digest-pinned images**; no arch declaration.
  - Docker access goes through a privileged `docker:*-dind` sidecar instead of a host socket mount
    (7 apps, e.g. `portainer`, `dockge`): 0 host socket mounts, 14 privileged apps.
- **`widgets`** (the only catalog with a dashboard-widget contract):
  `{id, type (e.g. "text-with-progress"), refresh, endpoint: "<service>:<port>/<path>", link, example{...}}`.
  Example: `back-that-mac-up/umbrel-app.yml`.
- **License:** the `umbrel-apps` repo has **no LICENSE file** (GitHub API: none). umbrelOS itself
  (`getumbrel/umbrel`) is **PolyForm Noncommercial 1.0.0**.
  - Importing or redistributing umbrel-apps content is legally unclear at best, and it is tightly coupled
    to umbrelOS runtime services.
  - Recommendation: do **not** build an Umbrel adapter. At most, use public metadata such as names and
    upstream URLs for duplicate detection, and get legal review before going further.
- **How umbrelOS syncs:** not verified (umbrelOS is not analysed here).

---

## 8. Quantitative security and structure survey

### 8.1 Method

- **Unit:** one app.
  - CasaOS / Big Bear: each `Apps/<dir>` containing `docker-compose.yml`.
  - Runtipi: each `apps/<id>` with `config.json`. The compose source is the one the current backend
    uses: native YAML if it has `x-runtipi` (20 apps), else `docker-compose.json` (250). Fields were
    mapped from camelCase.
  - Coolify: each template **not** marked `# ignore: true` (359).
  - Umbrel (included for comparison): `umbrel-app.yml` + compose. The injected `app_proxy` service is
    excluded.
- An app counts as flagged when **any** of its services has the property.
- **Parse failures:** none in CasaOS, Big Bear, Runtipi or Umbrel. Two Coolify templates (`gramps-web`,
  `langfuse`) fail in PyYAML (merge key on a sequence); they were parsed from the published JSON
  instead.
- **Detection rules:**

  | Property | Rule |
  |---|---|
  | `privileged` | `privileged: true` |
  | host network | `network_mode: host` (Runtipi: `networkMode`) |
  | `docker.sock` | any bind source matching `docker.sock`. A Podman socket in Coolify's `glances` template was **not** counted. |
  | sensitive bind | host path equal to, or under, `/etc`, `/root`, `/proc`, `/sys`, `/dev`, `/var/run`, `/run`, or exactly `/`; after substituting `${VAR:-default}` defaults |
  | `security_opt` unconfined | `apparmor[:=]unconfined`, `seccomp[:=]unconfined` or `label[:=]disable` |
  | "high risk" | privileged, host network, `pid: host`, a `docker.sock` mount, unconfined `security_opt`, or a sensitive bind other than `docker.sock` |

- **Image pinning** is counted per image reference, not per app.

### 8.2 Results per app

| Metric | CasaOS (n=179) | Big Bear (n=466) | Runtipi (n=270) | Coolify (n=359) | Umbrel (n=393) |
|---|---|---|---|---|---|
| `privileged: true` | 8 (4.5%) | 13 (2.8%) | 8 (3.0%) | 3 (0.8%) | 14 (3.6%) |
| `network_mode: host` | 16 (8.9%) | 27 (5.8%) | 10 (3.7%) | 6 (1.7%) | 27 (6.9%) |
| `cap_add` (any) | 9 (5.0%) | 18 (3.9%) | 7 (2.6%) | 10 (2.8%) | 11 (2.8%) |
| `devices` | 13 (7.3%) | 9 (1.9%) | 5 (1.9%) | 1 (0.3%) | 3 (0.8%) |
| GPU reservation / `runtime: nvidia` | 10 (5.6%) | 2 (0.4%) | 1 (0.4%) | 0 | 0 |
| `/var/run/docker.sock` mount | 7 (3.9%) | 30 (6.4%) | 13 (4.8%) | 20 (5.6%) | 0 |
| Sensitive host bind (incl. docker.sock) | 17 (9.5%) | 51 (10.9%) | 35 (13.0%) | 26 (7.2%) | 14 (3.6%) |
| … excluding docker.sock | 12 (6.7%) | 24 (5.2%) | 25 (9.3%) | 7 (1.9%) | 14 (3.6%) |
| … excluding docker.sock and `/etc/localtime`, `/etc/timezone` | 7 (3.9%) | 16 (3.4%) | 6 (2.2%) | 3 (0.8%) | 8 (2.0%) |
| `pid: host` | 2 (1.1%) | 1 (0.2%) | 2 (0.7%) | 1 (0.3%) | 0 |
| `ipc: host` | 2 (1.1%) | 0 | 0 | 0 | 0 |
| `userns_mode: host` | 0 | 0 | 0 | 0 | 0 |
| `security_opt` apparmor/seccomp unconfined, label disable | 2 (1.1%) | 4 (0.9%) | 3 (1.1%) | 3 (0.8%) | 2 (0.5%) |
| `sysctls` | 2 (1.1%) | 2 (0.4%) | 3 (1.1%) | 2 (0.6%) | 1 (0.3%) |
| **Any high-risk setting** | **32 (17.9%)** | **75 (16.1%)** | **47 (17.4%)** | **31 (8.6%)** | **36 (9.2%)** |
| Multiple services | 25 (14.0%) | 84 (18.0%) | 80 (29.6%) | 189 (52.6%) | 160 (40.7%) |
| Uses `build:` | 0 | 0 | 0 | 0 | 0 |
| Healthcheck on ≥1 service | 19 (10.6%) | 52 (11.2%) | 37 (13.7%) | 334 (93.0%) | 67 (17.0%) |
| Healthcheck on all services | 5 (2.8%) | 21 (4.5%) | 12 (4.4%) | 299 (83.3%) | 19 (4.8%) |
| Fixed `container_name` | 171 (95.5%) | 244 (52.4%) | 0 | 8 (2.2%) | 5 (1.3%) |
| Publishes a host port < 1024 | 6 (3.4%) | 58 (12.4%) | 7 (2.6%) | 2 (0.6%) | 3 (0.8%) |

Examples, for building test fixtures:
- **privileged**:
  - CasaOS: `HomeAssistant`, `Frigate`, `Handbrake`;
  - Big Bear: `big-bear-casaos-user-management`, `netalertx`;
  - Runtipi: `homebridge`, `scrypted`, `stirling-pdf`.
- **docker.sock**: `Portainer`, `Netdata` (CasaOS); `dozzle`, `dockge`, `authentik` (several catalogs);
  `gitea-runner`, `github-runner` (Coolify).
- **bind of `/`**: CasaOS `ProjectNOMAD`; Big Bear `cadvisor`, `ncdu`, `openvscode-server`; Runtipi
  `dashdot`, `qdirstat`.
- **pid: host**: `Glances`, `Netdata`.

### 8.3 Capabilities and sensitive paths

| Catalog | Most frequent `cap_add` (apps) | Sensitive host paths (apps) |
|---|---|---|
| CasaOS | NET_ADMIN 5, SYS_ADMIN 4, SYS_MODULE 2, NET_RAW 2, SYS_RESOURCE, SYS_PTRACE, DAC_READ_SEARCH | docker.sock 7, /etc/localtime 5, /etc/timezone 3, /run/dbus, /proc, /sys, /, /run/udev, /etc/passwd, /etc/group, libvirt-sock |
| Big Bear | NET_ADMIN 10, NET_RAW 5, SYS_ADMIN 3, SYS_MODULE 3, SETUID/SETGID/CHOWN 3, DAC_OVERRIDE 2, NET_BIND_SERVICE 2 | docker.sock 30, /etc/localtime 12, /sys 4, /dev 4, /proc 3, / 3, /run/udev 3, /run/systemd/system, /sys/fs/cgroup |
| Runtipi | NET_ADMIN 6, SYS_ADMIN 2, SYS_MODULE 2, SYS_PTRACE 1 | /etc/localtime 19, docker.sock 13, / 2, /etc/timezone 2, /dev, /proc, /sys, /run/dbus, /dev/net/tun |
| Coolify | NET_ADMIN 4, SYS_ADMIN 3, CHOWN/FOWNER/SETUID/SETGID/DAC_OVERRIDE 2, SYS_PTRACE, SYS_TIME, SYS_MODULE | docker.sock 20, /etc/localtime 4, podman.sock 1, /run/dbus 1, /dev/urandom 1 |

### 8.4 Image references

| Catalog | Image refs | Fixed tag | `:latest` | No tag (implicit latest) | Variable tag | Digest-pinned |
|---|---|---|---|---|---|---|
| CasaOS (source) | 252 | 218 (86.5%) | 24 (9.5%) | 2 (0.8%) | 0 | 8 (3.2%) |
| Big Bear | 610 | 21 (3.4%) | 4 (0.7%) | 2 (0.3%) | 0 | 583 (95.6%) |
| Runtipi | 396 | 350 (88.4%) | 38 (9.6%) | 8 (2.0%) | 0 | 0 |
| Coolify | 744 | 500 (67.2%) | 181 (24.3%) | 42 (5.6%) | 21 (2.8%) | 0 |
| Umbrel | 676 | – | – | – | – | 676 (100%) |

The CasaOS **v2 published** per-arch compose files are digest-pinned by the builder on a best-effort
basis (§2.5). All references in a 25-file sample were pinned.

### 8.5 Architecture coverage and reliability

Declared coverage per app:

| Catalog | amd64 | arm64 | 32-bit arm | Nothing declared |
|---|---|---|---|---|
| CasaOS | 179 (100%) | 152 (84.9%) | 42 (23.5%) `arm` | 0 |
| Big Bear | 466 (100%) | 402 (86.3%) | 16 (3.4%) `armv7` | 0 |
| Runtipi | 270 (100%) | 253 (93.7%) | n/a | 0 (and missing would mean both) |
| Coolify | 1 (`amd_only`) | 0 | 0 | 358 (99.7%) |
| Umbrel | – | – | – | 393 (100%) |

Spot check:
- **Method:** a random sample (seed 20261010) of each catalog's **main** image (the `x-casaos.main` or
  `isMain` service), resolved through the Docker Hub tags API or the ghcr.io/quay.io registry API.
- **CasaOS, arm64 claimed:** 0 of 25 wrong.
- **Big Bear, arm64 claimed:** **2 of 25 wrong**. `kasmweb/chrome:1.15.0-rolling` and
  `analogic/poste.io:2.5.17` are amd64-only.
- **Runtipi, arm64 claimed:** 0 of 25 wrong.
- **Runtipi, amd64-only claimed:** **7 of 16 under-declared**. One was unresolvable because it is on
  `registry.gitlab.com`.
- **Coolify (no claim):** 23 of 23 main images have arm64. Two were unresolvable: one variable tag, one on
  codeberg.org.
- **Conclusion:** declarations are mostly right but not authoritative. Sidecars were not checked.
  **Otuken should verify against the registry manifest at import or install time**, as the CasaOS v2
  builder does.

### 8.6 Secrets and versions (heuristics)

- **Literal values for secret-like env keys** (`PASS|SECRET|TOKEN|API_KEY|PRIVATE_KEY|SALT|JWT`, value
  without `$`):

  CasaOS 41/179 (22.9%), Big Bear 120/466 (25.8%), Runtipi 10/270 (3.7%), Coolify 9/357.
  The Coolify count includes false positives such as `ALLOW_EMPTY_PASSWORD` and `*_REDACT_SECRETS`, and
  that heuristic run skipped the two templates that use merge keys. Runtipi and Coolify generate secrets
  instead (`random` form fields, `SERVICE_PASSWORD_*`).
- **Version field vs main image tag mismatches:** CasaOS `x-casaos.version` is not a substring of the
  tag in 43/179 apps; Big Bear `config.json.version` differs in 50/466; Runtipi `config.version` differs
  in 27/250.

---

## 9. Recommended normalized model mapping

Suggested unified fields, with types expressed in TypeScript terms. Columns show the source of each
field.

| Unified field | CasaOS / ZimaOS (incl. Big Bear) | Runtipi | Coolify | Portainer v3 | Umbrel (reference only) |
|---|---|---|---|---|---|
| `id` (`<catalog>:<nativeId>`) | `x-casaos.id`; fall back to compose `name` for v1-only stores | `config.id` (URN `id:store`) | file slug (JSON key) | `id` (int) or slugified `title` | `id` |
| `name` | `x-casaos.title[locale]` | `config.name` | headline-cased slug; there is no display-name field | `title` | `name` |
| `description` (localized `Record<locale,string>`) | `tagline` (short) + `description` (long), locale maps | `short_desc` + `metadata/description.md` (en only) | `slogan` (en) | `description` + `note` | `tagline` + `description` |
| `icon` | `x-casaos.icon` (URL); v2: `base_url + index.icon` | `metadata/logo.jpg` (file in repo) | `public/svgs/<logo>` in repo | `logo` (URL) | not in manifest (hosted separately; not verified) |
| `screenshots` | `screenshot_link[]`, `thumbnail` | none | none | none | `gallery[]` (file names) |
| `category` / `tags` | `category` (9-value enum) | `categories[]` (15-value enum) | `category` (free text) + `tags[]` | `categories[]` (free text) | `category` |
| `sourceCatalog` | store `store_id` / repo URL | store URL / slug | `coollabsio/coolify` | template URL | – |
| `sourceRef` | commit SHA (source) or `gh-pages` SHA + `index.updated_at` + `content_hash` (v2) | commit SHA + `tipi_version` | commit SHA + `template_last_updated_at` | commit SHA of the JSON | commit SHA |
| `version` (app) | `x-casaos.version` (Big Bear: `config.json.version`) | `config.version` | none; derive from image tag | none | `version` |
| `supportedArchitectures` | `architectures[]` (normalize `arm`/`armv7` → `arm/v7`, `386`/`i386` → `386`); verify | `supported_architectures` (default both); verify | `amd_only`/`arm_only`, else **unknown**; verify | `platform` (OS only) | none |
| `ports[]` `{container, host?, protocol, role: web\|other, userEditable}` | compose `ports`; `port_map` + `main` + `index` + `scheme` = web entry; service `x-casaos.ports[].description` = label | `internalPort` + `isMain` → web; `addPorts` → other; `port` = default host port; `url_suffix`, `https` | `# port` + `SERVICE_URL_<N>_<PORT>` → web (proxied); compose `ports` rare | `ports[]` strings | `port` + `app_proxy` env |
| `volumes[]` `{target, kind: appData\|userData\|hostPath\|named, hostPathTemplate}` | binds under `/DATA/AppData/$AppID` → appData; other `/DATA/*` → userData; others → hostPath | `${APP_DATA_DIR}` → appData; `${ROOT_FOLDER_HOST}/media` → userData | named volumes → named; `./x` with `content` → generated file | `volumes[{container, bind}]` | `${APP_DATA_DIR}` |
| `environment[]` `{key, default?, required, secret, userEditable, generator?}` | compose env (literal defaults); `x-casaos.envs` → `userEditable` + label; secret = key heuristic | `form_fields` (`required`, `default`, `type: password` → secret, `random` → generator; `regex`, `min`/`max`, `options`); compose env otherwise | `${VAR:-default}` → editable with default; `SERVICE_PASSWORD_*` etc. → generator + secret; `SERVICE_URL/FQDN_*` → platform-provided | `env[{name, label, default, preset, select}]` | `defaultPassword`, `deterministicPassword` |
| `dependencies` | compose `depends_on` (intra-app only) | `dependsOn` | `depends_on` | none | `dependencies[]` (other apps) |
| `requiredCapabilities` (derived) | derive from compose: privileged, cap_add, devices, network_mode, pid, sockets, host paths, GPU | same, from camelCase fields | same | `privileged` | same |
| `images[]` `{ref, tag, digest?, pinned}` | all `services.*.image`; v2: per-arch digests | `services[].image` + `overrides[]` per arch | `services.*.image` (may contain `${...}`) | `image` | `image` (digest) |
| `healthCheck` | compose `healthcheck` | `healthCheck` | compose `healthcheck` (+ `exclude_from_hc`) | none | compose |
| `installMethod` | `compose` (rewrite `$AppID`/`/DATA`) | `compose-generated` (from JSON or native, after the env build) | `compose-magic-env` | `container` \| `stack-git` | unsupported |
| `documentationUrl` | `x-casaos.docs` (Big Bear: `config.json.docs_link`) | – | `documentation` (strip `?utm_source`, fix the double `?`) | – | `support` |
| `website` | `x-casaos.website` | `website` | – | – | `website` |
| `repository` | `x-casaos.repo` | `source` | – | – | `repo` |
| `author` / `developer` | `author` (packager) / `developer` (upstream) | `author` (upstream) | – | – | `developer`, `submitter` |
| `preInstallNotes` (localized) | `tips.before_install` | `form_fields[].hint` | comments only | `note` | `releaseNotes` |
| `minResources` | `deploy.resources.reservations.memory` (v2 `min_memory`) | `deploy.resources` | `deploy` | – | – |
| `widgets` | – | – | – | – | `widgets[]` (the only usable source; model it as a hint, `{type, endpoint: service:port/path, refresh}`) |
| `deprecated` / `available` | – | `deprecated`, `available` | `# ignore` | – | `disabled` |
| `minPlatformVersion` | – | `min_tipi_version` (not portable) | `minversion` (not portable) | – | – |

Normalization rules worth fixing in code:
- **Placeholder translation table**, from source token to Otuken token:

  | Source token | Otuken token |
  |---|---|
  | `$AppID`, `${AppID}` | `{{app.instanceId}}` |
  | `$PUID`, `$PGID` | `{{host.uid}}`, `{{host.gid}}` |
  | `$TZ`, `${TZ}` | `{{host.tz}}` |
  | `/DATA/AppData/<x>` | `{{paths.appData}}` |
  | `/DATA/<Media\|Downloads\|...>` | `{{paths.userData}}/...` |
  | `${APP_DATA_DIR}` | `{{paths.appData}}` |
  | `${ROOT_FOLDER_HOST}/media` | `{{paths.userData}}` |
  | `${APP_PORT}` | `{{ports.web.host}}` |
  | `${APP_DOMAIN}`, `${APP_HOST}`, `${APP_PROTOCOL}` | `{{ingress.*}}` |
  | `SERVICE_URL_*`, `SERVICE_FQDN_*` | `{{ingress.*}}` |
  | `SERVICE_PASSWORD_*` and other generators | `{{secret.generate(...)}}` |

- **Unknown variables** must remain unresolved and block the install until the user supplies a value.
  Never fall back to the host environment (CasaOS does).
- **Free-text placeholders** such as `[CHANGE_TO_LAN_IP]` should be detected
  (`/\[CHANGE[_A-Z]*\]/`) and surfaced as required user input.
- **Locale keys:** normalize to BCP-47 (`en_US` → `en-US`). Map `en_UK` to `en-GB` and treat `de` as
  `de-DE`.

---

## 10. Duplicate detection

The same product appears in several catalogs under different ids, images and versions. Observed:

| Product | CasaOS | Big Bear | Runtipi | Coolify | Umbrel |
|---|---|---|---|---|---|
| Jellyfin | `org.icewhale.jellyfin` / `linuxserver/jellyfin:12.2ubu2604-ls53` | `com.bigbeartechworld.jellyfin` / `linuxserver/jellyfin:12.1ubu2604-ls50@sha256:…` | `jellyfin` / `lscr.io/linuxserver/jellyfin:version-12.2ubu2604` | `jellyfin` / `lscr.io/linuxserver/jellyfin:10.11.8` | `jellyfin` / `linuxserver/jellyfin:version-12.2ubu2604@sha256:…` |
| Uptime Kuma | `org.icewhale.uptimekuma` / `louislam/uptime-kuma:2.4.0` | `com.bigbeartechworld.uptime-kuma` / `…:2@sha256` | `uptime-kuma` / `…:2` | `uptime-kuma` / `…:2` | `uptime-kuma` / `…:2.5.5@sha256` |
| Home Assistant | `org.icewhale.homeassistant` / `homeassistant/home-assistant` | `com.bigbeartechworld.home-assistant` / `ghcr.io/home-assistant/home-assistant` | `homeassistant-1` / `ghcr.io/home-assistant/home-assistant` | `home-assistant` / `ghcr.io/home-assistant/home-assistant` | `home-assistant` / `homeassistant/home-assistant` |
| Syncthing | `org.icewhale.syncthing` / `linuxserver/syncthing` | `…syncthing` / `syncthing/syncthing` | `syncthing` / `syncthing/syncthing` | `syncthing` / `lscr.io/linuxserver/syncthing:latest` | `syncthing` / `syncthing/syncthing` |
| Nextcloud | `org.icewhale.nextcloud` / `nextcloud` | `…nextcloud` / `bigbeartechworld/big-bear-nextcloud-with-smbclient` | `nextcloud` / `nextcloud` | `nextcloud` / `lscr.io/linuxserver/nextcloud:latest` | `nextcloud` (first service is `mariadb`) |

Pairwise overlap (apps sharing at least one non-database image repository after normalization; generic
images such as postgres, redis, mariadb, mysql, mongo, nginx and valkey excluded):

| Pair | Shared image repos | Apps in the first catalog matched |
|---|---|---|
| CasaOS–Big Bear | 64 | 65 |
| CasaOS–Runtipi | 70 | 71 |
| CasaOS–Coolify | 55 | 57 |
| Big Bear–Runtipi | 140 | 146 |
| Big Bear–Coolify | 100 | 111 |
| Runtipi–Coolify | 101 | 104 |

Normalized-id overlaps (lowercase, alphanumerics only, `big-bear-` stripped): CasaOS–Runtipi 67,
Big Bear–Runtipi 123, Runtipi–Coolify 89.

Across the pairs CasaOS–Big Bear, CasaOS–Runtipi, Big Bear–Runtipi and Runtipi–Coolify, 31 normalized
name matches use **different** image repositories:
- `FreshRSS`: `freshrss/freshrss` vs `linuxserver/freshrss`;
- `Emby`: `emby/embyserver` vs `linuxserver/emby`;
- `Grafana`: `grafana/grafana` vs `grafana/grafana-oss`;
- `WebDav`: `ugeek/webdav` vs `bytemark/webdav` (different implementations).

Recommended algorithm (score-based; never auto-merge on one signal):
1. **Canonical image key** of the *main* service:
   - use `x-casaos.main`, `isMain` or `x-runtipi.is_main`, or Coolify's `SERVICE_URL_*` owner, or the
     only non-database service;
   - lowercase; strip the registry for `docker.io`, `index.docker.io`, `ghcr.io`, `lscr.io` and
     `quay.io`; strip the tag and digest; add `library/` for single-segment names;
   - keep a small alias table, e.g. `homeassistant/home-assistant` ≡ `home-assistant/home-assistant`.

   Strong signal when equal. Treat it as a variant, not a different app, when only the publisher differs
   (`linuxserver/X` vs `X/X`).
2. **Normalized slug**:
   - lowercase the last segment of the `x-casaos.id`, the Runtipi `id` or the Coolify file name;
   - strip `big-bear-`, `-1` suffixes (Runtipi `authentik-1`, `homarr-1`) and non-alphanumerics.

   Medium signal.
3. **Upstream URL** (`x-casaos.repo`, Runtipi `source`, Umbrel `repo`, Coolify `documentation` host):
   normalize GitHub owner/repo. Strong signal when present.
4. **Variant markers** keep apps separate even when the image matches:
   - suffixes `_Nvidia`, `-host`, `-without-machine-learning`, `-with-*`;
   - a different `network_mode`, or GPU reservations.

   Examples: CasaOS `Jellyfin` vs `Jellyfin_Nvidia`; Big Bear `adguard-home` vs `adguard-home-host`.
5. Present duplicates as **one logical app with several offers** (catalog, version, risk score). Never
   merge their compose definitions.

---

## 11. Format auto-detection (cheap, no execution)

Work on the archive file listing first, then on at most a few small files. Strip the archive's top-level
`<repo>-<ref>/` directory. GitHub archives carry the commit SHA in the tar pax header or the zip comment;
record it as `sourceRef`.

| Format | Decisive signals (all must hold) | Confirming signals |
|---|---|---|
| **CasaOS/ZimaOS v2 published** | JSON at the URL root with `version == 2` and `store_id`; `index.json` has `apps[].compose_url`, `meta_url`, `content_hash` | `base_url`; `apps/<id>/meta.json` |
| **CasaOS-family source** | an `Apps/` directory (case-sensitive) whose subdirectories contain `docker-compose.yml` or `.yaml`, and a sampled compose has top-level `x-casaos` | `store-config.json` (`version: 2`), `category-list.json`, `recommend-list.json`, `supported-languages.json` |
| CasaOS v1 zip | path `build/sysroot/var/lib/casaos/appstore/default.new/Apps/` | contains a `.sh` setup script (ignore it) |
| Big Bear flavour | the above plus `Apps/<x>/config.json` with `{id, version, image}` | compose `name: big-bear-*`; `x-casaos.id` starts with `com.bigbeartechworld.` |
| **Runtipi** | an `apps/` directory (lowercase) whose subdirectories contain `config.json` with `tipi_version` and `short_desc` | `apps/*/metadata/logo.jpg`; `docker-compose.json` with `schemaVersion`; `$schema` pointing to `schemas.runtipi.io`; top-level `x-runtipi` in YAML |
| **Coolify templates JSON** | a JSON object whose values all have `compose` (base64) and `slogan` | `logo: "svgs/..."`, `minversion`, `template_last_updated_at` |
| **Coolify templates directory** | `templates/compose/*.yaml` with a leading `# documentation:` / `# slogan:` comment block | `templates/service-templates-latest.json` present; `SERVICE_(URL\|FQDN\|PASSWORD\|USER)_` tokens |
| **Portainer** | a JSON object `{version: "2"\|"3", templates: [ {type: 1\|2\|3, title, ...} ]}`, or a top-level array (v1 files `master/templates.json` and `templates-1.20.0.json`; `templates.json` uses `type: "container"`/`"stack"` strings) | `platform`, `repository.stackfile` |
| **Umbrel** (reject or flag) | `*/umbrel-app.yml` with `manifestVersion` | `app_proxy` service; `exports.sh`; `umbrel-app-store.yml` (community stores; not verified here) |
| Plain compose collection (fallback) | `*/docker-compose.y?ml` without any of the above | |

Order the checks from most to least specific:
1. v2 store JSON
2. Runtipi `config.json` + `tipi_version`
3. Coolify header
4. CasaOS `x-casaos`
5. Portainer
6. Umbrel
7. plain compose

Cap the file sizes you read: for example, 256 KB per compose file, and reject archives with more than
20 k entries, path traversal, or symlinks.

---

## 12. Security policy implications

What the numbers mean for an install-time policy:
- Roughly **one in six** CasaOS, Big Bear and Runtipi apps, and **one in eleven** Coolify apps, need at
  least one setting that removes container isolation.
- These apps are popular infrastructure tools, e.g. Home Assistant, Homebridge, Portainer, Netdata,
  Glances, Dozzle and cloudflared. Blocking them all is not realistic.
- The policy therefore has to be **tiered with explicit, per-capability consent**.

| Setting | Default action | Rationale and numbers |
|---|---|---|
| `privileged: true` | **Block by default**; allow only with an explicit "full host access" consent that names the app | 0.8–4.5% of apps. It equals root on the host. Umbrel uses it for DinD instead of socket mounts. |
| `/var/run/docker.sock` (or any `*.sock` of a container engine, e.g. `podman.sock`) | **Block by default**; consent "can control all containers (root-equivalent)". Offer a read-only socket proxy as a safer alternative. | 3.9–6.4%. Mostly Docker management and monitoring apps. A `:ro` flag does **not** make it safe. |
| Bind of `/`, `/proc`, `/sys`, `/dev` (whole), `/etc` (except `localtime`/`timezone`), `/root`, `/run` (except `dbus`/`udev` when requested), `/var/run` | **Block**; consent per path | 0.8–3.9% after removing benign mounts. Default to read-only where the app works with it. |
| `/etc/localtime:ro`, `/etc/timezone:ro` | **Allow** | Common and harmless (up to 19 Runtipi apps). Better: replace with the `TZ` env. |
| `network_mode: host` | **Warn** with consent; it is needed for mDNS, DLNA and HomeKit (Home Assistant, Homebridge, Plex, cloudflared) | 1.7–8.9% |
| `pid: host`, `ipc: host`, `userns_mode: host` | **Block**; consent only for monitoring apps | ≤1.1% |
| `cap_add` | Allow none by default. **Warn** for `NET_ADMIN`, `NET_RAW` (VPN/DNS). **Block plus consent** for `SYS_ADMIN`, `SYS_MODULE`, `SYS_PTRACE`, `DAC_READ_SEARCH`, `SYS_RAWIO`. Allow `CHOWN`, `SETUID`, `SETGID`, `DAC_OVERRIDE`, `FOWNER`, `NET_BIND_SERVICE` silently. | 2.6–5.0%. `NET_ADMIN` is the most common everywhere. |
| `security_opt` with `apparmor`/`seccomp` unconfined or `label:disable` | **Block**; consent | ≤1.1% |
| `devices` | **Warn** and show the list. Allow GPU nodes (`/dev/dri`, `/dev/nvidia*`) with a hardware consent; block raw disks (`/dev/sd*`, `/dev/nvme*`) unless explicitly granted. | up to 7.3% (CasaOS, mostly media transcoding) |
| `sysctls` | **Warn**; allow only namespaced (`net.*`) sysctls | ≤1.1% |
| Host ports < 1024 | **Warn** about conflicts (DNS 53, HTTP 80/443) | 12.4% in Big Bear |
| Fixed `container_name` | **Rewrite** (prefix with the Otuken instance id) to avoid cross-catalog collisions | 95.5% CasaOS, 52.4% Big Bear |
| `build:` | **Block** (never build from catalog content) | 0% observed, so there is no cost |
| Unpinned images (`latest`, untagged, variable tag) | **Warn**. Resolve to a digest at install time and record it, as the CasaOS v2 builder does. | 10.3% CasaOS, 11.6% Runtipi, 32.7% Coolify of image refs; about 1% Big Bear, 0% Umbrel |
| Arch mismatch | **Block** when the registry manifest lacks the host platform for any service image; ignore the declared list when it conflicts with the registry | Declarations are wrong in both directions (§8.5) |
| Hard-coded secrets in env | **Warn** and offer to replace with generated secrets | 22.9% CasaOS, 25.8% Big Bear |
| Catalog-shipped scripts (`*.sh`, `exports.sh`, setup scripts) and Coolify `content:` files | Never execute scripts. Treat `content:` files as data written under the app's own data directory only, after path normalization. | v1 zip contains `.sh`; Umbrel has 74 `exports.sh`; Coolify has 34 `content:` templates |
| Unresolved variables | **Block** until resolved. Never read the host environment. | CasaOS's fallthrough behaviour |

Implementation note: compute a `requiredCapabilities` set during normalization (§9) and evaluate the
policy against the **fully interpolated** compose (run `docker compose config` on generated output, never
on catalog input with host env). Store the consent decision together with `sourceRef`. A catalog update
that adds a capability must require consent again.

---

## 13. Open points not verified

- The ZimaOS client's actual import endpoints and v2 handling: its source is not public. §3 relies on the
  store docs and a third-party report.
- Why Big Bear's v2 build stopped publishing after 2026-08-17.
- How umbrelOS and Portainer refresh their catalogs internally (not needed for adapters).
- Whether Runtipi's `POSTGRES_PASSWORD` reaches `app.env`. The code path copies the whole base `.env`
  map (which contains `JWT_SECRET`), but the runtime file contents were not inspected.
- The meaning of Portainer `type: 4` in `templates-2.0.json`.
- Sidecar images were not part of the architecture spot check.

---

## 14. Sources

All read on 2026-10-10.

- https://github.com/IceWhaleTech/CasaOS-AppStore: `README.md`, `LICENSE`, `store-config.json`,
  `category-list.json`, `supported-languages.json`, `docs/specs/*.md`, `docs/migration/*.md`,
  `docs/cicd/{release-store-workflow,release-workflow}.md`, `docs/faq/overview.md`,
  `docs/resources/recommended-third-party-stores.md`, `.github/workflows/release-store.yml`,
  `.github/actions/{build-store-v1,validate-compose}/scripts/*.py`, `scripts/build_dist.sh`,
  `Apps/*/docker-compose.yml`.
- https://github.com/IceWhaleTech/CasaOS-AppStore/tree/gh-pages: `store.json`, `index.json`, `CNAME`,
  `metadata.sha256`, `store/main.zip`, `apps/org.icewhale.jellyfin/*`, plus 25 sampled per-arch compose
  files. Fetched via https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@gh-pages/,
  https://raw.githubusercontent.com/IceWhaleTech/CasaOS-AppStore/gh-pages/ and
  https://api.github.com/repos/IceWhaleTech/CasaOS-AppStore/git/trees/gh-pages?recursive=1.
- https://github.com/IceWhaleTech/build-appstore-action: `scripts/build_appstore.py`.
- https://github.com/IceWhaleTech/CasaOS-AppManagement: `service/{appstore,compose_service,compose_app}.go`,
  `route/v2/appstore.go`, `pkg/utils/cpu.go`, `common/constants.go`, `api/app_management/openapi.yaml`,
  `build/sysroot/etc/casaos/app-management.conf.sample`, `cmd/migration-tool/migration_0415_and_older.go`.
- https://github.com/IceWhaleTech/ZimaOS: `README.md` and repository contents.
- https://github.com/bigbeartechworld/big-bear-casaos: `LICENSE`, `README.md`, `store-config.json`,
  `config.json`, `Apps/*/{docker-compose.yml,config.json}`, `.github/workflows/release.yml`. Also
  https://cdn.jsdelivr.net/gh/bigbeartechworld/big-bear-casaos@gh-pages/{store,index}.json and
  https://api.github.com/repos/bigbeartechworld/big-bear-casaos/actions/workflows/release.yml/runs.
- https://github.com/runtipi/runtipi-appstore: `LICENSE`, `apps/{app-info-schema,dynamic-compose-schema}.json`,
  `apps/docker-compose.common.yml`, `apps/*/{config.json,docker-compose.json,docker-compose.yml}`.
- https://github.com/runtipi/runtipi (branch `develop`): `packages/common/src/schemas/{app-info,compose-yaml}.ts`,
  `packages/backend/src/modules/{apps,app-stores,docker/builders,env,app-lifecycle}/*.ts`,
  `packages/backend/src/common/helpers/env-helpers.ts`,
  `packages/frontend/src/modules/app/containers/app-actions/app-actions.tsx`.
- https://schemas.runtipi.io/v2/dynamic-compose.json
- https://github.com/coollabsio/coolify: `LICENSE`, `config/constants.php`,
  `app/Console/Commands/Generate/Services.php`, `bootstrap/helpers/{shared,parsers,services}.php`,
  `templates/compose/*`, `templates/service-templates{,-latest}.json`, `public/svgs/`.
- https://cdn.coollabs.io/coolify/service-templates-latest.json
- https://github.com/portainer/templates: `v3/templates.json`, `v3/README.md`,
  `master/{templates,templates-1.20.0,templates-2.0}.json`.
- https://github.com/portainer/portainer/blob/develop/api/portainer.go (`DefaultTemplatesURL`) and
  https://docs.portainer.io/advanced/app-templates/format
- https://github.com/getumbrel/umbrel-apps (`*/umbrel-app.yml`, `*/docker-compose.yml`) and
  https://github.com/getumbrel/umbrel/blob/master/LICENSE.md
- https://www.zimaspace.com/docs/zimaos/app-store/awesome-third-party-stores
- https://github.com/chicohaager/zima-appstore (README section "Why a store.json and not a zip")
- Docker Hub tags API (`https://hub.docker.com/v2/repositories/<repo>/tags/<tag>`) and the ghcr.io/quay.io
  registry manifest APIs, used for the §8.5 spot check.
