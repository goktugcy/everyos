# Official EveryOS apps

The 33 apps EveryOS ships in its official registry (`dev.everyos.*`). Each folder is one app, built
with the public SDK exactly like a third-party app: it runs in EveryOS's sandbox, uses only the
capabilities its manifest declares, and is packed and signed as an `.eosapp`. Nothing here has
access a community app could not have.

[`scripts/official-apps.config.ts`](../scripts/official-apps.config.ts) lists them (slug, id,
name, icon, colors, category); `node scripts/official-app-icons.ts` draws their icons.
[Notes](notes/) is the reference app: read it before writing another.

## Layout of an app

```
manifest.json          id dev.everyos.<slug>, publisher dev.everyos, sdk ^1.0.0, 10 locales
everyos.config.json    entries (app.js, widget.js …) and workers
package.json           @everyos-official/<slug>; libraries from the workspace catalog
public/index.html      loads app.css and app.js (module), nothing inline
public/widget.html     one per widget
public/icon.svg        generated, do not edit
public/locales/*.json  en, tr, de, es, fr, it, ja, ko, ru, zh — the same keys in every file
src/main.tsx           only: styles, then `void boot(App)`
src/widget.tsx         only: styles, then `void boot(Widget)`
src/*.tsx, src/*.ts    the app: components, state, pure logic in their own modules
src/env.d.ts           `declare module "*.css";`
test/*.test.ts(x)      unit tests of the logic and interface tests (below)
README.md              what it does, permissions and why, storage keys, development
```

## Rules

- **Complete workflows.** Every feature the app advertises works end to end against the real SDK.
  No placeholder buttons, no "coming soon", no disabled menu items for missing features, no
  invented data. When EveryOS cannot provide something (no permission, the machine cannot measure
  it, simulated data on a development installation), say so in the interface with the reason.
- **The kit.** Build the interface from `@everyos/app-ui` (Shell, Toolbar, buttons, fields,
  dialogs, lists, tables, empty/loading/error states, toasts, settings) and its hooks
  (`usePersistentState`, `useShortcuts`, `useAsync`, `useNarrow`, `useDebounced`). Add an app's
  own CSS only for what the kit does not cover, with the kit's variables (`--eui-*`), never fixed
  colors, so light, dark and accent themes work. Editors use `CodeEditor` from
  `@everyos/app-ui/editor`; Markdown uses `renderMarkdown` from `@everyos/app-ui/markdown`.
- **Texts.** Every visible text, label, `aria-label`, tooltip and toast comes from the locale
  files through `useT()`; the kit's own texts are under `ui.*` (Cancel, Save, Delete …), do not
  repeat them. Plurals use `key_one` / `key_other` (and Russian `_few` / `_many`). Dates and
  numbers use `useI18n().date()` / `.number()`. `app.name`, `app.description` and each widget's
  `widgets.<id>.name` / `.description` are required. Translations are natural, not word for word.
- **Permissions.** Declare the fewest capabilities; explain each in the README. Handle
  `EVERYOS_PERMISSION_DENIED` (`errorMessage(t, error)`) and `permissions.onChange`. Destructive
  actions ask with `app.dialogs.confirm(…, { destructive: true })`.
- **Data.** Per-person state lives in `app.storage` (values up to 256 KiB each: split large data
  over keys; migrate with `storage.migrate`). Save as people work and flush on
  `lifecycle.onSuspend` and `pagehide`; nothing typed may be lost. Files only through the picker
  (`openTextFile`, `openFiles`, `saveTextFile`, `exportJson`, `importJson`). Validate everything
  read from files or storage before using it.
- **Security.** Never render untrusted HTML except through `renderMarkdown` or DOMPurify. No
  `eval`, no `new Function`, no remote code (the content security policy blocks it anyway). Work
  that may hang (regular expressions on large input) runs in a worker with a time limit
  (`workers` in everyos.config.json, `startWorker()`).
- **Keyboard and accessibility.** Every action is reachable by keyboard; list navigation with the
  arrows; shortcuts for frequent actions (`useShortcuts`, shown with `shortcutLabel`); icon
  buttons have labels; focus is visible; dialogs trap focus (the kit's `Dialog` does).
- **Responsive.** Usable from 360 px wide (sidebars collapse, `useNarrow`) to full screen.
- **Widgets** (when the app has one): small, quick, with the app's storage; `window.open(state)`
  opens the app at the right place and the app handles `window.onOpened`.

## Tests

Vitest project `official-apps` (happy-dom, `@everyos/app-testing/setup`):

```ts
import { renderApp } from "@everyos/app-ui/testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";

const rendered = await renderApp(App, {
  publicDir: join(import.meta.dirname, "../public"),
  granted: ["storage:app"],
  locale: "tr",
});
// … interact, then expect what the person would see and what the app stored or sent.
rendered.unmount();
```

Test the logic thoroughly as plain functions (parsers, calculators, formatters, recurrence,
conversions), and the main workflows through the interface against the mock desktop. Never weaken
an assertion to make a test pass. `tests/e2e/official-apps.spec.ts` installs every app with a
manifest on a real EveryOS in a real browser.

## Commands

```bash
pnpm exec vitest run --project official-apps official-apps/<slug>
pnpm --filter @everyos-official/<slug> typecheck
cd official-apps/<slug> && pnpm exec everyos-app validate
pnpm exec eslint official-apps/<slug> && pnpm exec prettier --check official-apps/<slug>
```
