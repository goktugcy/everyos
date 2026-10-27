# Widgets of desktop apps

An app holding `widgets:register` declares widgets in its manifest (`widgets`: id, name,
description, entry document, sizes, placements and the capabilities the widget uses, a subset of
the app's). Once the app is installed and active, its widgets appear in the widget gallery under
**Apps**, named from the app's locale files (`widgets.<id>.name` and `.description`), and can be
placed on the desktop, in the sidebar or in the menu bar, as the manifest allows.

- A widget's id in the person's layout is `<app id>#<widget id>` (for example
  `dev.everyos.pomodoro#timer`); the preferences schema accepts it next to built-in ids.
- The widget is the app's own document in the same sandboxed frame as its windows, loaded only
  once it comes into view. It gets its own instance token: the server allows it only the
  capabilities its widget declares (`requireCapability` checks the widget's list on every call).
- Widgets have no window: window, dialog, file picker and appearance methods are refused
  (`EVERYOS_UNKNOWN_METHOD`); a widget can open the app's window with `window.open(state)`. A new
  window starts with that state (`window.initialState`); a window already open is brought to the
  front and hears it through `window.onOpened(state => …)` (Notes opens the note a widget names).
- Storage is the app's (per person), so a widget shows what the app saved.
- When the app is turned off or uninstalled, its widgets say so and can be removed; they come
  back if it is installed again.
