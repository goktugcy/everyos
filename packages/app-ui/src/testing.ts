import { mountMockHost, type MockHost, type MockHostOptions } from "@everyos/app-testing";
import { servePackageFiles } from "@everyos/app-testing/dom";
import type { EveryOSApp } from "@everyos/app-sdk";
import { EditorView } from "@codemirror/view";
import type { ComponentType } from "react";
import { boot } from "./app.tsx";

/*
 * Starts an official app's interface against the MOCK desktop of `@everyos/app-testing`, in a test
 * DOM, with its package files (locales) served from `publicDir`. Nothing here talks to EveryOS.
 */

export interface RenderedApp {
  host: MockHost;
  app: EveryOSApp;
  container: HTMLElement;
  /** Stops the app and the mock (call it after each test). */
  unmount(): void;
}

export async function renderApp(
  Root: ComponentType,
  options: MockHostOptions & { publicDir: string },
): Promise<RenderedApp> {
  const { publicDir, ...hostOptions } = options;
  const stopFiles = servePackageFiles(publicDir);
  const host = mountMockHost(hostOptions);
  const container = document.createElement("div");
  container.id = "app";
  document.body.replaceChildren(container);
  const booted = await boot(Root, { container });
  if (!booted) {
    host.unmount();
    stopFiles();
    throw new Error(container.textContent ?? "The app did not start");
  }
  return {
    host,
    app: booted.app,
    container,
    unmount() {
      booted.unmount();
      host.unmount();
      stopFiles();
      container.remove();
    },
  };
}

/** The CodeMirror view of the first (visible) CodeEditor inside `within`. */
export function editorView(within: ParentNode = document): EditorView {
  const editors = [...within.querySelectorAll<HTMLElement>(".cm-editor")];
  const element = editors.find((entry) => !entry.closest("[hidden]")) ?? editors[0];
  const view = element ? EditorView.findFromDOM(element) : null;
  if (!view) throw new Error("No code editor");
  return view;
}

/** Types into a CodeEditor as a person would (appended, or replacing everything). */
export function typeInEditor(
  text: string,
  options: { within?: ParentNode; replace?: boolean } = {},
): void {
  const view = editorView(options.within);
  view.dispatch({
    changes: {
      from: options.replace ? 0 : view.state.doc.length,
      to: view.state.doc.length,
      insert: text,
    },
    userEvent: "input.type",
  });
}
