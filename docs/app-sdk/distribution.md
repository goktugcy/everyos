# Standalone SDK distribution

The SDK is distributed as five npm-compatible archives attached to the complete EveryOS release:
`@everyos/app-sdk`, `@everyos/app-testing`, `@everyos/app-ui`, `@everyos/app-cli` and
`create-everyos-app`. SDK version 1.0.3 is independent of the EveryOS version. Publication to npm
is optional and has not been performed by the development workflow.

```bash
pnpm sdk:build
pnpm sdk:verify
pnpm sdk:check
```

The build writes `dist/sdk/`. Each archive contains compiled ESM, its complete declaration closure,
license and package metadata. The generator includes all four templates; the CLI includes its
prebuilt, explicitly simulated developer desktop. Public manifests contain no workspace or private
runtime dependencies. The browser SDK has no third-party runtime dependency. The UI's optional
editor exports keep their existing dependency contracts. Repository package manifests stay private.

Published package versions are immutable. Bump the coordinated SDK package version when archive
bytes change, including when the generator embeds a different default EveryOS release URL.

`sdk-report.json` binds the source commit, dirty state, EveryOS/SDK versions and the exact five
archives to byte lengths, SHA-256 hashes and npm SHA-512 integrity values. The verifier rejects
missing, duplicate, renamed, changed or additional files, incompatible versions and symbolic links.
The OS packager selects only its API, agent, CLI, updater and web runtime; SDK archives, catalog
assets and acceptance reports are separate release assets.

`sdk:check` installs the actual generator with `npm exec` in a temporary directory outside the
repository. For each template it installs the real tarballs with install scripts disabled, rejects
workspace links, typechecks and runs its tests, packs an app, publishes and verifies an ephemeral
signed private registry, refreshes and revokes a version, and starts the packaged developer host.
The widget template also compiles the public UI package, renders its installed components and
checks an actual click event. The report is `dist/sdk-acceptance.json`.
CI runs this qualification on both Linux architectures; failures remain release blockers.

To try a local build without publication:

```bash
npm exec --yes --package ./dist/sdk/create-everyos-app-1.0.3.tgz -- create-everyos-app /tmp/my-everyos-app --template react --packages "$PWD/dist/sdk"
cd /tmp/my-everyos-app
npm install --ignore-scripts
npm run typecheck
npm test
npm run dev
```

The protected release job signs the exact report bytes with the OS release Ed25519 key using the
`everyos-sdk-distribution/1` domain separator. It publishes `sdk-report.sig` beside the archives
and verifies the signature before uploading. With an independently trusted release public key,
the matching checkout can verify the downloaded directory offline:

```bash
node scripts/sdk.ts verify /path/to/sdk-assets /path/to/trusted-release-public.pem
```

Unsigned development verification attests to local file integrity; it does not establish a publisher
identity. Production private keys are only supplied to the protected signing job.

## Public release readiness

The package job runs `node scripts/release-preflight.ts` before any signing. An absent community
anchor, a missing live acceptance receipt or an invalid/expired live signed index blocks publication.
The production service and independent public-key pin are present, and the real human-reviewed
six-step lifecycle passes. The current receipt binds EveryOS 0.1.40 to
[immutable live evidence](../evidence/community-20261030/live-lifecycle.json). Standalone SDK tests
remain one part of the complete release gate.

`https://registry.everyos.net/index.json` and its independently retained key are pinned in
`apps/api/src/modules/desktop-apps/anchors.ts`. The actual enrollment, submission, human review,
installation, update and revocation results are recorded in
`packaging/community-live-acceptance.json`, following `CommunityReleaseEvidence` in
`scripts/community-release-gate.ts`. For each release the receipt must match the candidate version
and key fingerprint, link its supporting HTTPS evidence, and be no more than 30 days old. Local
workerd evidence cannot substitute for this receipt. The protected workflow signs and verifies the
final OS, SDK and official app artifacts together before publishing the complete release.

Historical lifecycle receipts retain the origin on which the human review actually occurred.
After the 2026-10-28 domain change a receipt from the legacy origin also requires fresh migration
evidence for the exact old/new origins, the same signing key and identical signed catalogs from both
endpoints. The fresh 0.1.40 lifecycle uses the canonical origin for installation, update and
revocation checks, while retaining the existing owner-verified publisher and its origin-bound
credential on the legacy alias. Migration evidence does not replace the six lifecycle checks,
their candidate-version binding or their freshness limit.
