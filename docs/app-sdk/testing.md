# Testing EveryOS apps

## The mock desktop

`@everyos/app-testing` is a **mock** of the desktop's end of the app bridge. It keeps everything in
memory and never talks to EveryOS, so it proves nothing about production security. It applies the
same capability rules as EveryOS (a capability not granted is refused with
`EVERYOS_PERMISSION_DENIED`), refuses window-only methods in widgets, and records what the app did.

```ts
// @vitest-environment happy-dom
import { mountMockHost } from "@everyos/app-testing";

const host = mountMockHost({
  granted: ["storage:app", "files:pick"],
  locale: "tr",
  files: { "/notes/today.md": "# Bugün" },
  host: { "net.dns": () => ({ status: "ok", records: [] }) },
});
await import("../src/main.ts"); // the app connects to the mock as it would to EveryOS
// host.storage, host.files, host.calls, host.notifications, host.clipboard, host.window …
host.setGranted(["storage:app"]); // the app hears permissions.changed
host.setLocale("en");
host.setTheme(DARK_THEME);
```

`host.call` operations answer only what you pass in `host`; others fail with
`EVERYOS_MOCK_UNANSWERED`, so a test never silently gets made-up data. `host.emit(event, data)`
plays the desktop's events (`window.opened`, `lifecycle.suspend` …). `unmount()` restores the page
and lets the next `mountMockHost()` connect again, so one test file can start the app many times.

### Interfaces

`@everyos/app-testing/dom` has small helpers for a test DOM: `typeInto` (React sees the change),
`pressKey` (`mod` is Ctrl), `byText`, `allByText`, `byRole` (role and accessible name) and
`servePackageFiles(publicDir)`, which answers the app's requests for its own files (locales) as
EveryOS would.

Add `@everyos/app-testing/setup` to Vitest's `setupFiles` when the app sanitizes HTML (DOMPurify)
or walks the DOM while changing it: it makes happy-dom's `NodeIterator` and `Node.nodeName` behave
as the DOM standard says, without which sanitizers drop content in tests. It is never loaded on
EveryOS.

```ts
// vitest.config.ts
export default defineConfig({
  test: { environment: "happy-dom", setupFiles: ["@everyos/app-testing/setup"] },
});
```

## The developer page

`everyos-app dev` serves the app with EveryOS's exact sandbox flags and content security policy,
inside a page labelled **MOCK · NOT EVERYOS**, with controls to:

- show the window or any widget,
- grant or revoke capabilities (from the manifest),
- switch the theme (EveryOS's own light and dark tokens) and language,
- add files from your computer that the file picker then offers,
- watch calls, notifications, the clipboard, storage and validation findings.

Every save rebuilds and reloads the app; its storage and files stay, as after an update on
EveryOS.

## On a real EveryOS

```bash
npx everyos-app dev --registry --host 0.0.0.0
```

prints a registry URL, its public key and fingerprint. In EveryOS, an administrator opens **App
Store → Catalog sources → Add source**, chooses _Private_ and _on my local network_, and pastes
them. Install the app; after a change, **Sync now** and **Update**. The app then runs exactly like
any installed app: in EveryOS's sandbox, with the permissions people approve, its network and
database access governed by the administrator's policies. Development mode bypasses nothing.

Development registries cannot carry ids in EveryOS's reserved namespaces (`dev.everyos.*`).

Host responders can throw `BridgeError` from `@everyos/app-sdk` to simulate server errors,
including the original `code` and `details` (for example a blocked network target). Ordinary
exceptions remain generic mock validation failures. This tests app recovery through the bridge;
it does not verify the production policy, which still needs API and browser tests.
