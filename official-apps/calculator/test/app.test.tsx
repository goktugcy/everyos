import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import type { MockHostOptions } from "@everyos/app-testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalculatorApp } from "../src/calculator-app.tsx";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(CalculatorApp, {
    publicDir,
    app: { id: "dev.everyos.calculator", version: "1.0.0", name: "Calculator" },
    granted: ["storage:app", "clipboard:write"],
    ...options,
  });
  await vi.waitFor(() => expect(document.querySelector(".calc-field")).not.toBeNull());
  return rendered;
}

const key = (name: string) => {
  const button = byRole("button", name);
  if (!button) throw new Error(`No key ${name}`);
  button.click();
};
const result = () => document.querySelector(".calc-result")?.textContent ?? "";
const field = () => document.querySelector<HTMLInputElement>(".calc-field")!;

describe("Calculator", () => {
  it("calculates from the keypad and keeps the history", async () => {
    const { host } = await start();
    for (const name of ["1", "2", "Add", "3", "Multiply", "4", "Equals"]) key(name);
    await vi.waitFor(() => expect(result()).toBe("24"));
    await vi.waitFor(() => expect(field().value).toBe("24"));
    // Operators continue from the result; digits start over.
    key("Subtract");
    key("4");
    key("Equals");
    await vi.waitFor(() => expect(result()).toBe("20"));
    key("7");
    await vi.waitFor(() => expect(field().value).toBe("7"));
    await vi.waitFor(() =>
      expect(host.storage.get("history")).toEqual([
        expect.objectContaining({ expression: "24−4", result: "20" }),
        expect.objectContaining({ expression: "12+3×4", result: "24" }),
      ]),
    );
    byText("12+3×4 =")!.click();
    await vi.waitFor(() => expect(field().value).toBe("12+3×4"));
  });

  it("takes typed expressions in the person's language and explains errors", async () => {
    await start({ locale: "tr" });
    typeInto(field(), "0,1+0,2");
    await vi.waitFor(() => expect(result()).toBe("0,3"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(field().value).toBe("0,3"));
    typeInto(field(), "1/0");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(result()).toBe("Sıfıra bölünemez"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(field().value).toBe(""));
  });

  it("uses scientific functions with the angle unit and the memory", async () => {
    const { host } = await start();
    byRole("tab", "Scientific")!.click();
    await vi.waitFor(() => expect(byRole("button", "Sine")).not.toBeNull());
    typeInto(field(), "sin(30)");
    key("Equals");
    await vi.waitFor(() => expect(result()).toBe("0.5"));
    key("Store in memory");
    await vi.waitFor(() => expect(host.storage.get("memory")).toBe("0.5"));
    typeInto(field(), "2");
    key("Add to memory");
    await vi.waitFor(() => expect(host.storage.get("memory")).toBe("2.5"));
    key("Clear");
    key("Recall memory");
    await vi.waitFor(() => expect(field().value).toBe("2.5"));
    byRole("button", "Degrees")!.click();
    typeInto(field(), "sin(pi/2)");
    key("Equals");
    await vi.waitFor(() => expect(result()).toBe("1"));
    await vi.waitFor(() =>
      expect(host.storage.get("settings")).toMatchObject({ mode: "scientific", angle: "rad" }),
    );
  });

  it("copies the result", async () => {
    const { host } = await start({ locale: "de" });
    typeInto(field(), "1234.5*2");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(result()).toBe("2.469"));
    byRole("button", "Ergebnis kopieren")!.click();
    await vi.waitFor(() => expect(host.clipboard).toEqual(["2469"]));
  });

  it("converts units", async () => {
    await start();
    byRole("tab", "Converter")!.click();
    await vi.waitFor(() => expect(byRole("combobox", "Quantity")).not.toBeNull());
    const quantity = byRole("combobox", "Quantity") as HTMLSelectElement;
    quantity.value = "temperature";
    quantity.dispatchEvent(new Event("change", { bubbles: true }));
    typeInto(byRole("textbox", "Value"), "100");
    await vi.waitFor(() =>
      expect(document.querySelector(".calc-converter-result")?.textContent).toBe("212 °F"),
    );
    byRole("button", "Swap units")!.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".calc-converter-result")?.textContent).toBe(
        "37.77777777777778 °C",
      ),
    );
  });
});
