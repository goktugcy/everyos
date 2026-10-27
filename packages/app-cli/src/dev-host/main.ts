/*
 * The page of `everyos-app dev`: the app in an iframe with EveryOS's exact sandbox flags (its files
 * are served with EveryOS's CSP), talking to a MOCK desktop from @everyos/app-testing. Controls
 * simulate permissions, theme, locale, widgets and the files a person picks; panels show what the
 * app did. Nothing here is EveryOS: a real test needs a developer EveryOS instance.
 */
import { APP_FRAME_SANDBOX } from "@everyos/app-manifest";
import { DARK_THEME, LIGHT_THEME, MOCK_LABEL, MockHost } from "@everyos/app-testing";

interface DevManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  permissions: string[];
  widgets: Array<{ id: string; name: string; entry: string; permissions: string[] }>;
  locales?: { supported: string[]; default: string };
  window?: { defaultWidth: number; defaultHeight: number };
}
interface DevState {
  manifest: DevManifest | null;
  findings: Array<{ level: string; file: string; message: string }>;
  build: { ok: boolean; error: string | null; at: number };
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

let state: DevState = { manifest: null, findings: [], build: { ok: true, error: null, at: 0 } };
let host: MockHost | null = null;
let instance = "window";
let theme: "light" | "dark" = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let locale = "en";
let granted = new Set<string>();
const files: Record<string, Uint8Array> = {};
/** Kept across reloads: an app's storage survives a new version, as on EveryOS. */
const storage: Record<string, unknown> = {};

function pickDialog(
  title: string,
  candidates: string[],
  multiple: boolean,
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const dialog = element("dialog", { className: "picker" });
    const list = element("div", { className: "list" });
    const chosen = new Set<string>();
    for (const path of candidates) {
      const input = element("input", { type: multiple ? "checkbox" : "radio", name: "pick" });
      input.addEventListener("change", () => {
        if (!multiple) chosen.clear();
        if (input.checked) chosen.add(path);
        else chosen.delete(path);
      });
      list.append(element("label", {}, input, ` ${path}`));
    }
    if (!candidates.length)
      list.append(element("p", {}, "No matching files: add some under Files."));
    const done = (value: string[] | null) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const ok = element("button", { type: "button" }, "Choose");
    ok.addEventListener("click", () => done(chosen.size ? [...chosen] : null));
    const cancel = element("button", { type: "button" }, "Cancel");
    cancel.addEventListener("click", () => done(null));
    dialog.append(
      element("h3", {}, `${MOCK_LABEL} · ${title}`),
      list,
      element("div", {}, cancel, ok),
    );
    document.body.append(dialog);
    dialog.showModal();
  });
}

function render(): void {
  const manifest = state.manifest;
  $("#app-name").textContent = manifest
    ? `${manifest.name} ${manifest.version}`
    : "(manifest invalid)";
  const findings = $("#findings");
  findings.replaceChildren(
    ...(state.build.error
      ? [element("li", { className: "error" }, `Build: ${state.build.error}`)]
      : []),
    ...state.findings.map((finding) =>
      element("li", { className: finding.level }, `${finding.file}: ${finding.message}`),
    ),
  );
  if (!state.findings.length && !state.build.error)
    findings.append(
      element("li", { className: "ok" }, "Valid: EveryOS would accept this package."),
    );
  const permissions = $("#permissions");
  permissions.replaceChildren(
    ...(manifest?.permissions ?? []).map((capability) => {
      const input = element("input", { type: "checkbox", checked: granted.has(capability) });
      input.addEventListener("change", () => {
        if (input.checked) granted.add(capability);
        else granted.delete(capability);
        host?.setGranted([...granted]);
      });
      return element("label", {}, input, ` ${capability}`);
    }),
  );
  const instances = $<HTMLSelectElement>("#instance");
  instances.replaceChildren(
    element("option", { value: "window" }, "Window"),
    ...(manifest?.widgets ?? []).map((widget) =>
      element("option", { value: `widget:${widget.id}` }, `Widget: ${widget.name}`),
    ),
  );
  instances.value = instance;
  const locales = $<HTMLSelectElement>("#locale");
  locales.replaceChildren(
    ...(manifest?.locales?.supported ?? ["en"]).map((code) =>
      element("option", { value: code }, code),
    ),
  );
  locales.value = locale;
  renderFiles();
}

function renderFiles(): void {
  $("#files").replaceChildren(
    ...Object.entries(files).map(([path, data]) => element("li", {}, `${path} (${data.length} B)`)),
  );
}

function renderLog(): void {
  if (!host) return;
  $("#calls").replaceChildren(
    ...host.calls
      .slice(-80)
      .reverse()
      .map((call) =>
        element(
          "li",
          { className: call.ok ? "" : "error" },
          `${call.method}${call.ok ? "" : ` → ${call.error}`}`,
        ),
      ),
  );
  $("#notifications").replaceChildren(
    ...host.notifications.map((n) => element("li", {}, `[${n.level}] ${n.title} ${n.body}`)),
  );
  $("#clipboard").replaceChildren(...host.clipboard.map((text) => element("li", {}, text)));
  $("#storage").textContent = JSON.stringify(Object.fromEntries(host.storage), null, 2);
  for (const [path, file] of host.files) files[path] = file.data;
  for (const [key, value] of host.storage) storage[key] = value;
}

/** A fresh frame and mock for the chosen instance (a window, or one of the widgets). */
function mount(): void {
  const manifest = state.manifest;
  const stage = $("#stage");
  stage.replaceChildren();
  if (!manifest || !state.build.ok) return;
  const widget = instance.startsWith("widget:")
    ? manifest.widgets.find((entry) => entry.id === instance.slice(7))
    : undefined;
  const frame = element("iframe", { title: manifest.name });
  frame.setAttribute("sandbox", APP_FRAME_SANDBOX);
  frame.className = widget ? "widget" : "window";
  if (!widget && manifest.window) {
    frame.style.width = `${manifest.window.defaultWidth}px`;
    frame.style.height = `${manifest.window.defaultHeight}px`;
  }
  host = new MockHost({
    app: { id: manifest.id, version: manifest.version, name: manifest.name },
    kind: widget ? "widget" : "window",
    widgetId: widget?.id ?? null,
    granted: widget ? widget.permissions.filter((p) => granted.has(p)) : [...granted],
    theme: theme === "dark" ? DARK_THEME : LIGHT_THEME,
    locale,
    files,
    storage,
    pick: async (request) => {
      const candidates = Object.keys(files).filter((path) =>
        request.accept.length
          ? request.accept.some(
              (rule) => path.toLowerCase().endsWith(rule.toLowerCase()) || rule.endsWith("/*"),
            )
          : true,
      );
      return pickDialog(
        request.directory ? "Choose a folder" : "Open",
        request.directory ? ["/"] : candidates,
        request.multiple,
      );
    },
    saveAs: (request) => prompt(`${MOCK_LABEL} · Save as`, `/${request.suggestedName}`),
    confirm: (request) => confirm(`${MOCK_LABEL} · ${request.title}\n\n${request.message}`),
    prompt: (request) =>
      prompt(`${MOCK_LABEL} · ${request.title}\n\n${request.message}`, request.value),
  });
  const mock = host;
  frame.addEventListener("load", () => {
    const channel = new MessageChannel();
    mock.connect(channel.port1 as never);
    frame.contentWindow?.postMessage({ type: "everyos:init", protocol: 1 }, "*", [channel.port2]);
  });
  frame.src = `/app/${widget?.entry ?? manifest.entry}`;
  stage.append(frame);
}

async function refresh(remount: boolean): Promise<void> {
  const response = await fetch("/__everyos/state");
  state = (await response.json()) as DevState;
  if (state.manifest && !granted.size) granted = new Set(state.manifest.permissions);
  if (state.manifest?.locales && !state.manifest.locales.supported.includes(locale))
    locale = state.manifest.locales.default;
  render();
  if (remount) mount();
}

$("#instance").addEventListener("change", (event) => {
  instance = (event.target as HTMLSelectElement).value;
  mount();
});
$("#theme").addEventListener("change", (event) => {
  theme = (event.target as HTMLSelectElement).value as "light" | "dark";
  document.documentElement.dataset.theme = theme;
  host?.setTheme(theme === "dark" ? DARK_THEME : LIGHT_THEME);
});
$("#locale").addEventListener("change", (event) => {
  locale = (event.target as HTMLSelectElement).value;
  host?.setLocale(locale);
});
$("#reload").addEventListener("click", () => mount());
$("#add-files").addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  void Promise.all(
    [...(input.files ?? [])].map(async (file) => {
      files[`/${file.name}`] = new Uint8Array(await file.arrayBuffer());
    }),
  ).then(() => {
    renderFiles();
    mount();
  });
});
(document.querySelector("#theme") as HTMLSelectElement).value = theme;
document.documentElement.dataset.theme = theme;
setInterval(renderLog, 700);
// Rebuilds reload the app; its storage and files stay.
new EventSource("/__everyos/events").addEventListener("build", () => void refresh(true));
void refresh(true);
