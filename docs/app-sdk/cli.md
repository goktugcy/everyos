# everyos-app

`@everyos/app-cli` builds, checks, packs, signs and publishes EveryOS desktop apps. Run it from the
app's folder (the one with `manifest.json`).

| Command                                            | What it does                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `dev [--port 5180] [--host 127.0.0.1]`             | Rebuilds on every change and opens a developer page with a **mock** desktop (see [testing](testing.md)).                |
| `dev --registry`                                   | Also serves a signed development registry a real EveryOS can add (each build is a new `-dev.<time>` version).           |
| `build`                                            | Bundles the entries and workers with esbuild (minified) and copies `public/`, the assets and the manifest into `dist/`. |
| `validate`                                         | Builds, then checks the package exactly as EveryOS will (below). Fails on errors.                                       |
| `pack [--out file]`                                | Builds, validates (errors refuse) and writes `<id>-<version>.eosapp`.                                                   |
| `test [-- vitest args]`                            | Validates, then runs the project's Vitest tests.                                                                        |
| `keygen [--out keys/publisher]`                    | Creates an Ed25519 key pair; the `.key` file is readable by you only and never overwritten.                             |
| `sign <file.eosapp> [--key keys/publisher.key]`    | Writes `<file>.sig.json`: the package digest signed with your publisher key.                                            |
| `registry init`                                    | Creates your registry in `registry/` and its keys in `keys/` (`--id`, `--name`, `--publisher-id`, `--publisher-name`).  |
| `publish [--changelog text]`                       | Packs, signs and adds this version to your registry, then signs the index again.                                        |
| `registry refresh`                                 | Signs the index again with a later expiry (indexes are valid for 180 days).                                             |
| `registry revoke <app id> <version or *> --reason` | Revokes a version; EveryOS turns installed copies off at its next sync.                                                 |
| `registry info`                                    | Prints the registry key's fingerprint.                                                                                  |

Nothing is ever published to the official EveryOS registry from the CLI.

## What `validate` checks

- The manifest, with the same schema EveryOS uses (ids, versions, capabilities, widgets and their
  capabilities, locales, sizes and limits).
- Every file the manifest names exists (entry, icon, widget entries, a locale file per language).
- Every file is of a type EveryOS serves (HTML, JS, CSS, JSON, images, fonts, media, WebAssembly…).
- HTML the app sandbox would block: inline scripts, remote scripts or stylesheets, inline event
  handlers, `<base>`.
- Translations: every text of the default language exists in the others; `app.name` and each
  widget's `widgets.<id>.name` are there.
- Package limits: 64 MiB packed, 256 MiB unpacked, 10,000 files.
- Capabilities that need people's (sensitive) or an administrator's (elevated) approval are listed
  as warnings.

## Configuration

`everyos.config.json` (optional):

```json
{
  "entries": { "app.js": "src/main.tsx", "widget.js": "src/widget.tsx" },
  "workers": { "search.worker.js": "src/search-worker.ts" },
  "assets": { "pdfjs/cmaps/": "node_modules/pdfjs-dist/cmaps" },
  "publicDir": "public",
  "outDir": "dist",
  "registry": {
    "dir": "registry",
    "key": "keys/registry.key",
    "publisherKey": "keys/publisher.key"
  }
}
```

Without it, `src/main.tsx` (or `.ts`) becomes `app.js`.

Entries are ES modules: code they share, and code loaded with `import()`, goes into `chunks/`, so
a large library an app needs only for one view loads when that view opens. Each worker is bundled
into a single classic script of its own: an app runs in an opaque origin, where a worker can only
start from a blob URL of its code and only as a classic worker (`startWorker("search.worker.js")`
in `@everyos/app-ui` does that), so it cannot import modules or load chunks.

`assets` copies files a library loads at run time (fonts, WebAssembly, data files) from the
project, usually from a dependency in `node_modules`, into the package at build time: package path
→ file or folder. From a folder, only the file types EveryOS serves are copied. A single file is
published under its package path, so a licence without an extension ships as `LICENSE.txt`:
include the licences that ask to travel with the code you redistribute.
