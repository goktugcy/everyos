# Publishing EveryOS apps

EveryOS installs an app only through a chain of signatures it can check: the **registry key**
signs the registry's index, the index lists the **publishers** with their keys and namespaces,
the publisher key signs each **package's** digest, and the package's bytes must match it.

## Your own registry

```bash
npx everyos-app registry init --id myapps --name "My apps" \
  --publisher-id com.example --publisher-name "Example Ltd"
npm run publish:registry          # everyos-app publish
```

- `keys/registry.key` and `keys/publisher.key` are private: keep them out of version control (the
  templates' `.gitignore` does) and back them up. Losing them means publishing under a new key.
- `registry/` is a static directory (`index.json`, `packages/`, `icons/`). Host it on any web
  server: your VPS, object storage, GitHub Pages. Relative URLs inside it keep working wherever it
  is served from.
- Your app ids must start with your publisher id (`com.example.notes`). The namespaces
  `dev.everyos.*` and `everyos*` belong to the official registry.
- A published version never changes: publishing different bytes under the same version is
  refused. Raise the version instead.
- Indexes are valid for 180 days; `everyos-app registry refresh` signs it again. EveryOS refuses an
  index older than the last one it saw (rollback protection) and an expired one.
- `everyos-app registry revoke <id> <version|*> --reason "…"` turns installed copies off at their
  next sync.

People add your registry in **App Store → Catalog sources → Add source** with its URL, the
registry public key (`registry/registry.pub`) and its fingerprint (`everyos-app registry info`),
which they should compare with the one you publish on your website.

## The community registry

The community registry accepts submissions from independent developers without access to the
EveryOS repository: see [community submissions](community.md).

## The official registry

Only EveryOS's own apps are published there, by EveryOS's release process.

The built-in trust anchor is
`https://github.com/goktugcy/everyos/releases/latest/download/official-apps.json`, signed by the
Ed25519 registry key with fingerprint
`sha256:d0670c89bb20001940869994f8c59e10dfa44c552115a2e06496b47ff1ae5852`.
The public key is pinned in `apps/api/src/modules/desktop-apps/anchors.ts`; private signing keys
stay in the protected GitHub `release` environment. Pinning an anchor does not publish a release.
Until the complete SDK release is authorized and published, this index may be unavailable.

Packages and icons are assets of the same release. Use flat relative asset names in the index
(for example `dev.everyos.notes-1.0.0.eosapp`), which resolve against the original index URL,
or absolute version-specific release URLs. A `packages/` subdirectory is not a GitHub release
asset path. Every redirect, including GitHub's object-storage redirect, is DNS-checked and pinned;
private, link-local and metadata addresses remain blocked. Cross-origin redirects never inherit
a private registry's authorization header.

The community domain is `everyos.goktugceyhan.dev`. The anchor remains absent until the owner
deploys the service and verifies its separate production public key; see [community setup](community.md).

## The complete official-app release pipeline

The catalog in `scripts/official-apps.config.ts` and the explicit app/widget permission policy in
`scripts/official-app-permissions.json` cover exactly 29 apps. A missing app, an unlisted manifest,
a permission change, an incompatible SDK/EveryOS requirement, an incomplete locale, a skipped or
failed app test, or a corrupt package fails the complete build. Official apps default to English;
all ten locale dictionaries must have the same nonempty text keys (plural variants are normalized).
Permission status means **matched-policy**, not that the build replaces administrator approval.

```bash
pnpm official-apps:check
```

This development command executes the actual `official-apps` Vitest project, builds and validates
every app, packs deterministic archives, generates two ephemeral Ed25519 keys in memory, signs
packages, index and report, then independently verifies the complete directory. It writes
`dist/official-apps-check/`; choose a fresh directory with `--out` for a repeated run. Existing
output directories are refused rather than overwritten. No private key is persisted. The report
is explicitly `mode: "development"`; the production verifier refuses it. CI runs this gate on
both Linux architectures and uploads the report even when app validation fails.

Production uses two jobs in `.github/workflows/release.yml`:

1. After the existing exact-commit green-CI gate and source-version check, the package job runs
   `pnpm official-apps:build`. A production candidate requires a clean checkout. Actual app test
   results, including positive per-app assertion/suite counts and their JSON-report digest, enter
   the unsigned build report. Archives and icons are uploaded with that report.
2. The `sign` job runs in the protected `release` environment. It obtains the previous published
   official index with `node scripts/official-apps.ts previous`, verifies its pinned signature,
   then runs `pnpm official-apps:sign --sequence "$GITHUB_RUN_NUMBER" --previous-index
dist/previous-official-apps.json`. Only this step receives
   `EVERYOS_APP_REGISTRY_PRIVATE_KEY` and `EVERYOS_APP_PUBLISHER_PRIVATE_KEY`. Their derived public
   keys must match the committed registry and publisher pins. Keys are never written to a file,
   included in subprocess environments, printed, or placed in an artifact.
3. `pnpm official-apps:verify` checks the signed report, registry and publisher signatures, exact
   catalog coverage, source commit/version, byte lengths and SHA-256 hashes, safe extraction,
   built manifest, compatibility, translations, permissions and matching package/store icons.
   Only then can the existing publication step upload the app assets alongside the OS assets.

The [latest-release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
is queried with the workflow token; the public index download receives no authorization header.
Only a missing release or an existing release without `official-apps.json` is a first-index case.
Network errors, bad URLs, oversized responses and invalid previous signatures fail closed. The
first-index receipt contains `null`; later receipts contain the exact signed index. When there
is a prior index, the new release includes `official-apps-previous.json` and binds its digest into
the report. A sequence must increase, app versions cannot go backward or reuse different bytes,
revoked versions cannot reappear, and previous revocations are retained. Bump an app's manifest
version when its package bytes change, including after a bundled dependency change.

All published app assets have flat names: the 29 `.eosapp` files, matching icons,
`official-apps.json`, `official-app-registry.pub`, `official-app-publisher.pub`,
`official-apps-report.json` and, after the first index, `official-apps-previous.json`.
The report is `{report, signature}` JSON, with a domain-separated registry-key signature over the
canonical report. It records each app's name, id, version, checksum, build/manifest/test status,
localization and permission-policy match. Its source includes whether the tree was dirty, and its
mode distinguishes unsigned candidates, ephemeral development verification and production signing.
A failed build writes `status: "failed"` with the affected app identities and errors and cannot
be signed. Signed test results attest to the trusted build job's measured run; offline verification
does not rerun those historical tests. Rebuild/test with the matching checkout for fresh evidence.

The pipeline is implemented before publication. Creating a tag or public release still requires
the owner's explicit authorization and the remaining ecosystem acceptance gates. No production
signature or release is claimed merely because the ephemeral development gate passes.
