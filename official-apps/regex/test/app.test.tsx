import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMatch, type MatchRequest } from "../src/match-core.ts";
import type { WorkerLike } from "../src/matcher.ts";
import { RegexApp } from "../src/regex-app.tsx";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

/** The worker of the app, running in this test's thread (happy-dom has no workers). */
const inline = (): Promise<WorkerLike> => {
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown) {
      const { id, request } = message as { id: number; request: MatchRequest };
      setTimeout(() =>
        worker.onmessage?.({ data: { id, result: runMatch(request) } } as MessageEvent),
      );
    },
    terminate() {},
  };
  return Promise.resolve(worker);
};
const App = () => <RegexApp start={inline} />;

async function start(locale = "en") {
  rendered = await renderApp(App, {
    publicDir,
    app: { id: "dev.everyos.regex", version: "1.0.0", name: "Regex Tester" },
    granted: ["storage:app", "clipboard:write"],
    locale,
  });
  await vi.waitFor(() => expect(document.querySelector(".rx-pattern input")).not.toBeNull());
  return rendered;
}
const pattern = () => document.querySelector<HTMLInputElement>(".rx-pattern input")!;
const text = () => document.querySelector<HTMLTextAreaElement>(".rx-text textarea")!;
const marks = () =>
  [...document.querySelectorAll(".rx-highlight mark")].map((mark) => mark.textContent);

describe("Regex Tester", () => {
  it("highlights matches and lists groups as you type", async () => {
    await start();
    typeInto(pattern(), String.raw`(\d+)-(\d+)`);
    typeInto(text(), "10-20 and 3-4");
    await vi.waitFor(() => expect(marks()).toEqual(["10-20", "3-4"]));
    expect(byText("2 matches", "[role=status]")).not.toBeNull();
    expect(document.querySelectorAll(".rx-groups tr")).toHaveLength(4);
  });

  it("toggles flags, explains the pattern and previews replacements", async () => {
    await start("tr");
    typeInto(pattern(), "^ab");
    typeInto(text(), "ab\nab");
    await vi.waitFor(() => expect(marks()).toEqual(["ab"]));
    byRole("button", /çok satır/)!.click();
    await vi.waitFor(() => expect(marks()).toEqual(["ab", "ab"]));
    byRole("tab", "Açıklama")!.click();
    await vi.waitFor(() => expect(byText("Metnin başı (m ile satır başı)")).not.toBeNull());
    byRole("tab", "Değiştir")!.click();
    await vi.waitFor(() => expect(byRole("textbox", "Yerine konacak")).not.toBeNull());
    typeInto(byRole("textbox", "Yerine konacak"), "[$&]");
    await vi.waitFor(() =>
      expect(document.querySelector(".rx-replaced")?.textContent).toBe("[ab]\n[ab]"),
    );
  });

  it("explains invalid expressions, loads examples and saves expressions", async () => {
    const { host } = await start();
    typeInto(pattern(), "(unclosed");
    await vi.waitFor(() => expect(byText(/Not a valid expression/)).not.toBeNull());
    byRole("button", "Examples")!.click();
    await vi.waitFor(() => expect(byText("IPv4 address")).not.toBeNull());
    byText("IPv4 address", "button")!.click();
    await vi.waitFor(() => expect(marks()).toEqual(["192.168.1.1", "1.1.1.1"]));
    byRole("button", "Save")!.click();
    await vi.waitFor(() => expect(byRole("textbox", "Name")).not.toBeNull());
    typeInto(byRole("textbox", "Name"), "IPs");
    [...document.querySelectorAll("dialog button")]
      .find((button) => button.textContent === "Save")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() =>
      expect(host.storage.get("saved")).toEqual([expect.objectContaining({ name: "IPs" })]),
    );
  });
});
