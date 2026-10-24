# Getting started with EveryOS apps

An EveryOS desktop app is a small web app that runs in its own sandboxed window on the EveryOS
desktop. It talks to EveryOS only through `@everyos/app-sdk`, uses only the capabilities it
declares and people approve, and is distributed as a signed `.eosapp` package from a registry:
yours, the community registry, or (for EveryOS's own apps) the official one.

## Create an app

```bash
npx https://github.com/goktugcy/everyos/releases/download/v<EveryOS version>/create-everyos-app-1.0.0.tgz my-notes --template react
cd my-notes
npm install
npm run dev
```

Templates:

| Template       | What you get                                                           |
| -------------- | ---------------------------------------------------------------------- |
| `vanilla`      | TypeScript without a framework: a note that saves as you type          |
| `react`        | The same app with React 19                                             |
| `react-widget` | React, plus a widget for the desktop and sidebar that shows the note   |
| `hybrid`       | A frontend for a backend EveryOS knows as an integration (Uptime Kuma) |

Every template has English and Turkish texts, an icon, a manifest, tests against the mock desktop
(`npm test`), a TypeScript configuration (`npm run typecheck`) and a `.gitignore` that keeps your
private keys out of version control.

`--packages npm` names the SDK packages by version (when they are on npm); `--packages <url or
folder>` takes their `.tgz` files from another place, by default the EveryOS release the tool came
from.

## A project

```
manifest.json          what the app is and may do (docs/app-sdk/manifest.md)
public/                copied as is: index.html, icon.png, locales/<language>.json
src/main.ts(x)         bundled into app.js (and app.css)
everyos.config.json    optional: more entries (widgets), other folders
test/                  your tests (Vitest, happy-dom, @everyos/app-testing)
```

The app's HTML loads only its own files: EveryOS serves every app file with a content security
policy that blocks inline and remote scripts, inline event handlers and network access beyond the
app's own files (`everyos-app validate` reports what would be blocked).

## Next

- [Manifest reference](manifest.md): every field, capability and cross-field rule.
- [SDK reference](sdk-reference.md): every public method, host operation and error code.

- [CLI](cli.md): every `everyos-app` command.
- [Testing](testing.md): the mock desktop, and running on a real EveryOS.
- [Publishing](publishing.md): your own registry, the community registry.
- [Architecture](architecture.md), [permissions](architecture.md#capabilities), [files](../files.md),
  [network](network.md), [databases](databases.md), [SSH keys](ssh-keys.md),
  [appearance](appearance.md), [widgets](widgets.md).
