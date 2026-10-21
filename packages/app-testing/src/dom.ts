import { readFile } from "node:fs/promises";
import { join } from "node:path";

/*
 * Small helpers for testing app interfaces in a test DOM (happy-dom, jsdom) without extra
 * libraries: typing into controlled inputs, keys, finding elements by text or role, and serving the
 * package's own files (locale files) the way EveryOS would.
 */

/** Types `text` into an input or textarea the way a person does (React sees the change). */
export function typeInto(element: Element | null, text: string): void {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
    throw new Error("typeInto needs an input or a textarea");
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, text);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Presses a key (`mod` is Ctrl, as on Linux and Windows). */
export function pressKey(
  key: string,
  modifiers: { mod?: boolean; shift?: boolean; alt?: boolean } = {},
  target: EventTarget = document.activeElement ?? window,
): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      ctrlKey: modifiers.mod ?? false,
      shiftKey: modifiers.shift ?? false,
      altKey: modifiers.alt ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

const textOf = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();

/** Elements matching `selector` whose text contains (or equals, with `exact`) `text`. */
export function allByText(text: string | RegExp, selector = "*", exact = false): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)].filter((element) => {
    const value = textOf(element);
    if (text instanceof RegExp) return text.test(value);
    return exact ? value === text : value.includes(text);
  });
}

/** The innermost element with the text. */
export function byText(text: string | RegExp, selector = "*"): HTMLElement | null {
  const found = allByText(text, selector);
  return (
    found.find((element) => !found.some((other) => other !== element && element.contains(other))) ??
    null
  );
}

function labelAround(element: HTMLElement): string | null {
  const label = element.closest("label");
  if (!label) return null;
  const copy = label.cloneNode(true) as HTMLElement;
  for (const control of copy.querySelectorAll("input,select,textarea")) control.remove();
  return copy.textContent;
}

/** An element by role and accessible name (aria-label, its label or own text). */
export function byRole(role: string, name?: string | RegExp): HTMLElement | null {
  const implicit: Record<string, string> = {
    button: "button,[role=button]",
    textbox: "input:not([type]),input[type=text],input[type=search],textarea,[role=textbox]",
    checkbox: "input[type=checkbox],[role=checkbox]",
    radio: "input[type=radio],[role=radio]",
    spinbutton: "input[type=number],[role=spinbutton]",
    slider: "input[type=range],[role=slider]",
    switch: "[role=switch]",
    tab: "[role=tab]",
    option: "[role=option]",
    link: "a[href]",
    heading: "h1,h2,h3,h4,h5,h6",
    combobox: "select,[role=combobox]",
    listbox: "[role=listbox]",
    dialog: "dialog,[role=dialog]",
    alert: "[role=alert]",
    status: "[role=status]",
  };
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(implicit[role] ?? `[role=${role}]`),
  ];
  if (name === undefined) return candidates[0] ?? null;
  return (
    candidates.find((element) => {
      const label =
        element.getAttribute("aria-label") ??
        (element.id ? document.querySelector(`label[for="${element.id}"]`)?.textContent : null) ??
        // A control inside its <label> is named by the label's other text.
        (element.matches("input,select,textarea") ? labelAround(element) : null) ??
        textOf(element);
      const value = (label ?? "").trim();
      return name instanceof RegExp ? name.test(value) : value === name;
    }) ?? null
  );
}

/**
 * Answers the app's requests for its own files (`locales/en.json` …) from `publicDir`, as
 * EveryOS serves them from the package.
 */
export function servePackageFiles(publicDir: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: URL | RequestInfo) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      "http://localhost/app/",
    );
    const path = url.pathname.replace(/^\/app\//, "").replace(/^\//, "");
    if (path.split("/").includes("..")) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(join(publicDir, path)));
    } catch {
      return new Response(null, { status: 404 });
    }
  };
  return () => {
    globalThis.fetch = original;
  };
}
