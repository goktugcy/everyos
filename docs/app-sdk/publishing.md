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

The community anchor remains absent until the community service has its own domain and public key.
