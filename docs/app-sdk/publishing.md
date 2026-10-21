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
