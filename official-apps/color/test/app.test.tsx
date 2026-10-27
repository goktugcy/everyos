import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { byRole, byText, pressKey, typeInto } from "@everyos/app-testing/dom";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColorApp } from "../src/color-app.tsx";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});
const settle = () => new Promise((resolve) => setTimeout(resolve));

async function start(locale = "en") {
  rendered = await renderApp(ColorApp, {
    publicDir,
    app: { id: "dev.everyos.color", version: "1.0.0", name: "Color Studio" },
    granted: ["storage:app", "clipboard:write", "files:save"],
    locale,
  });
  await vi.waitFor(() => expect(byRole("textbox", "HEX")).not.toBeNull());
  await settle();
  return rendered;
}
const hex = () => (byRole("textbox", "HEX") as HTMLInputElement).value;

describe("Color Studio", () => {
  it("takes colors in any format and moves with the keyboard", async () => {
    const { host } = await start();
    typeInto(byRole("textbox", "RGB"), "rgb(255 0 0)");
    await vi.waitFor(() => expect(hex()).toBe("#ff0000"));
    await vi.waitFor(() => expect(host.storage.get("color")).toBe("#ff0000"));
    const hue = byRole("slider", "Hue")!;
    hue.focus();
    await settle();
    pressKey("ArrowRight", { shift: true }, hue);
    await vi.waitFor(() => expect(hex()).not.toBe("#ff0000"));
    expect((byRole("textbox", "HSL") as HTMLInputElement).value).toBe("hsl(9.9 100% 50%)");
    await settle();
    byRole("button", "Copy HEX")!.click();
    await vi.waitFor(() => expect(host.clipboard).toEqual(["#ff2a00"]));
  });

  it("checks contrast", async () => {
    await start("tr");
    byRole("tab", "Kontrast")!.click();
    await vi.waitFor(() => expect(byRole("textbox", "Metin")).not.toBeNull());
    typeInto(byRole("textbox", "Metin"), "#767676");
    await vi.waitFor(() => expect(document.querySelector(".cs-ratio")?.textContent).toBe("4.54:1"));
    expect(byText("AA geçer")).not.toBeNull();
    expect(byText("AAA geçmez")).not.toBeNull();
  });

  it("saves palettes and exports them as CSS", async () => {
    const { host } = await start();
    await settle();
    byRole("button", "Save harmony")!.click();
    await vi.waitFor(() => expect(host.storage.get("palettes")).toHaveLength(1));
    await settle();
    byRole("tab", "Saved")!.click();
    await vi.waitFor(() => expect(byRole("button", "Save CSS…")).not.toBeNull());
    await settle();
    byRole("button", "Save CSS…")!.click();
    await vi.waitFor(() =>
      expect(host.readText("/Complementary.css")).toMatch(
        /^:root \{\n {2}--complementary-1: #0284c7;/,
      ),
    );
  });

  it("previews the color in the EveryOS theme", async () => {
    await start();
    byRole("tab", "EveryOS theme")!.click();
    await vi.waitFor(() => expect(byText("Your theme (light)")).not.toBeNull());
    expect(byText("#0284c7", "code")).not.toBeNull();
  });
});
