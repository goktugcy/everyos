# Application manifest reference

`manifest.json` is the versioned contract for a desktop app. The CLI, registry and installer use
the same strict [schema](../../packages/app-manifest/src/schema.ts). Unknown fields are rejected,
including inside `window`, `publisher`, widgets, locales and integration configuration. A manifest
requests capabilities; approval and authorization remain separate checks on every operation.

## Complete minimal example

```json
{
  "manifestVersion": 1,
  "id": "com.example.inspector",
  "name": "Inspector",
  "version": "1.0.0",
  "description": "Inspect approved endpoints through EveryOS.",
  "entry": "index.html",
  "icon": "icon.svg",
  "category": "network",
  "permissions": ["storage:app", "network:outbound"],
  "window": {
    "defaultWidth": 960,
    "defaultHeight": 640,
    "minWidth": 360,
    "minHeight": 320,
    "instances": "single"
  },
  "widgets": [],
  "locales": {
    "default": "en",
    "supported": ["en", "tr"],
    "path": "locales"
  },
  "sdk": "^1.0.0",
  "publisher": { "id": "com.example", "name": "Example" },
  "license": "MIT"
}
```

The example needs `index.html`, `icon.svg` and matching locale files in the built package.
Validate a complete project with `everyos-app validate`; this also checks assets, translations
and sandbox compatibility. The example's network permission needs explicit administrator approval
and an allowed-target policy before it can reach an endpoint.

## Top-level fields

| Field             | Required | Contract                                                           |
| ----------------- | -------- | ------------------------------------------------------------------ |
| `manifestVersion` | yes      | Exactly `1`                                                        |
| `id`              | yes      | App identity in its publisher's reverse-DNS namespace              |
| `name`            | yes      | Display name, 1–48 characters                                      |
| `version`         | yes      | Package version; see version syntax below                          |
| `description`     | yes      | Plain text, 1–280 characters                                       |
| `entry`           | yes      | Package-relative `.html` entry point                               |
| `icon`            | yes      | Package-relative `.png`, `.webp` or `.svg`                         |
| `category`        | yes      | One category listed below                                          |
| `permissions`     | yes      | At most 24 distinct capabilities; `[]` requests none               |
| `window`          | yes      | Initial/minimum geometry and instance policy                       |
| `widgets`         | yes      | At most eight widgets; use `[]` for none                           |
| `locales`         | no       | Default, supported languages and package-relative locale directory |
| `minEveryOS`      | no       | Minimum compatible EveryOS version                                 |
| `sdk`             | yes      | Supported SDK version range; currently `1.0.0`                     |
| `publisher`       | yes      | Publisher identity, name and optional HTTPS URL                    |
| `license`         | no       | Plain text license identifier, 1–64 characters                     |
| `homepage`        | no       | HTTPS URL, at most 512 characters                                  |
| `source`          | no       | HTTPS source-code URL, at most 512 characters                      |
| `integration`     | no       | `{ "adapter": "adapter-id" }` for a hybrid app                     |

Plain-text fields must be trimmed and contain no ASCII control characters. Their contents are
data and are never rendered as HTML. Categories are `productivity`, `developer`, `system`,
`network`, `media`, `customization`, `utilities`, `education`, `games` and `other`.

## Identity, versions and paths

An app ID has 3–7 dot-separated segments; a publisher ID has 2–6. Each segment starts with a
lowercase ASCII letter, continues with lowercase letters, digits or hyphens, and has at most
63 characters. The full ID is at most 128 characters. The app ID must start with the publisher
ID followed by a dot: `com.example.notes` belongs to `com.example`; `com.example-other.notes`
does not. Only the official registry may use `dev.everyos`, its descendants or `everyos.*`.
The signed registry assigns publisher namespaces to keys; a name in a manifest establishes
no trust by itself.

Versions are `MAJOR.MINOR.PATCH`, optionally followed by a prerelease such as `-beta.1`; core
numbers have no leading zeroes. Build metadata (`+...`) is not supported. SDK ranges support
`*`, an exact version, `^`, `~` and `>=` with one version. Compound ranges, unions and wildcard
components such as `1.x` are rejected. A prerelease does not satisfy a range that names no
prerelease. `minEveryOS` is a version, not a range.

Package paths use `/` separators and are relative to the package root. No absolute paths,
empty segments, `.`/`..`, backslashes, query strings, fragments or remote URLs. A path is at
most 512 characters and 16 segments; each segment is at most 128 characters, starts with an
ASCII letter, digit or `_@+~-`, and thereafter may also contain `.`. For example,
`assets/icon.svg` is valid and `../icon.svg` is not. File extensions are checked independently.

## Window

All four dimensions (`defaultWidth`, `defaultHeight`, `minWidth`, `minHeight`) are required
integers from 160 to 4096, in CSS pixels. Minimum dimensions cannot exceed defaults. Choose
responsive content that also works in the mobile shell: the window manager owns placement and
available space.

`instances: "single"` reuses the app's existing window. A subsequent `window.open(state)` is
delivered through `window.onOpened`. `"multiple"` allows independent windows; use `storage:app`
to share durable data and `window.saveState` for per-window navigation state.

## Widgets

```json
{
  "id": "summary",
  "name": "Summary",
  "description": "A compact view of saved app data.",
  "entry": "widget.html",
  "sizes": ["small", "medium"],
  "defaultSize": "small",
  "placements": ["desktop", "sidebar"],
  "permissions": ["storage:app"]
}
```

Each widget requires all fields shown. IDs match `[a-z][a-z0-9-]{0,31}` and are unique within
the app. Names are at most 48 characters; descriptions at most 200. `entry` is an HTML package
path. `sizes` is a nonempty list from `compact`, `small`, `medium`, `large`; `defaultSize` must
be in it. `placements` is a nonempty list from `desktop`, `sidebar`, `menubar`.

A widget requests at most 16 capabilities, all already requested by its parent app. The parent
must request `widgets:register` when `widgets` is nonempty. Widget frames have their own
instances and only their declared grants. See [widgets](widgets.md) for execution, placement,
visibility, shared storage and opening the app from a widget.

## Capabilities

`standard` capabilities are mediated by the person or scoped to app data. `sensitive` grants
are shown to the installer. `elevated` grants require explicit administrator approval; an
installation or update does not imply approval. Role requirements below apply in addition to
the app's grant.

| Capability              | Risk      | Person's role permission | Purpose                                         |
| ----------------------- | --------- | ------------------------ | ----------------------------------------------- |
| `storage:app`           | standard  | none                     | App/user-specific storage                       |
| `files:pick`            | standard  | `files:read`             | Files/folders explicitly selected in the picker |
| `files:save`            | standard  | `files:write`            | Saving through a granted file handle            |
| `notifications:send`    | standard  | none                     | Scoped, bounded notifications                   |
| `clipboard:write`       | standard  | none                     | Copying text through EveryOS                    |
| `widgets:register`      | standard  | none                     | Declaring widget entry points                   |
| `appearance:manage`     | sensitive | `preferences:manage`     | The person's wallpaper/folder icons             |
| `system:metrics.read`   | sensitive | `system:read`            | System information, metrics and storage         |
| `system:sockets.read`   | sensitive | `system:read`            | Listening socket information                    |
| `system:network.read`   | sensitive | `system:read`            | Network interfaces and routes                   |
| `system:services.read`  | sensitive | `services:read`          | Service status                                  |
| `logs:read`             | sensitive | `logs:read`              | Authorized log queries                          |
| `storage:usage.read`    | sensitive | `files:read`             | Usage beneath a selected folder                 |
| `network:outbound`      | elevated  | none                     | Policy-approved HTTP, DNS, TLS and monitors     |
| `database:connect`      | elevated  | none                     | Administrator-configured database connectors    |
| `secrets:ssh`           | sensitive | none                     | App-owned SSH key management                    |
| `integration:<adapter>` | sensitive | `apps:read`              | A configured integration's declared feeds       |

The authoritative mapping is [capabilities.ts](../../packages/app-manifest/src/capabilities.ts).
Server policy, ownership, quotas and additional operation-specific confirmation still apply.
An app must handle grant withdrawal while open. It cannot gain privileges by hiding controls,
using a different bridge message or declaring itself official.

## Locales and hybrid integrations

`locales.default` must appear in `locales.supported`, which has no duplicates. Supported codes
are `en`, `tr`, `de`, `es`, `fr`, `it`, `ja`, `ko`, `ru`, `zh`. Each package locale file contains
`app.name`, `app.description`, and each declared widget's name and description under
`widgets.<id>`. Official apps include all ten languages. Use `{{name}}` interpolation and plural
suffixes with the [SDK i18n API](sdk-reference.md#internationalization).

An integration adapter matches `[a-z][a-z0-9-]{1,31}`. Requesting any `integration:*` capability
requires an `integration` declaration, and `integration.adapter` requires its matching
`integration:<adapter>` capability. The manifest does not contain backend addresses, credentials
or deployment commands. See the hybrid CLI template and
[architecture](architecture.md#capabilities) for the configured backend boundary.

## Validation and distribution

`parseManifest(value)` from `@everyos/app-manifest/schema` is server/tooling code and throws
`ManifestError` with `{ path, message }` issues. Do not import its zod schema into the desktop's
browser bundle. An application uses the public SDK's types and runtime instead.

Manifest validity is necessary but does not verify an app's behavior. The complete package must
also pass asset/HTML checks, integrity checks, publisher signature verification, registry trust,
SDK/EveryOS compatibility, permission approval and installation policy. See [CLI](cli.md),
[testing](testing.md), [publishing](publishing.md) and [release gates](../sdk-release-acceptance.md).
