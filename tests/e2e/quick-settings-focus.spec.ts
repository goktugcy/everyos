import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

test("quick settings keeps focus in an app selected before delayed dismissal completes", async ({
  page,
}) => {
  await page.clock.install();
  await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("terminal");
  await page.getByRole("option", { name: "Terminal", exact: true }).click();
  const app = page.locator('[data-app-id="everyos.terminal"]').last();
  await expect(app.getByTestId("terminal-app")).toHaveAttribute("data-terminal-phase", "connected");
  const input = app.getByRole("textbox", { name: "Terminal girdisi" });
  const trigger = page.getByRole("button", { name: "Hızlı ayarlar", exact: true });
  await trigger.click();
  await page.getByRole("radio", { name: "Minimal Clear", exact: true }).click();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("data-state", "closed");
  await input.focus();
  // Hold Radix's deferred restoration until the person has selected another input.
  await page.clock.runFor(50);
  await page.clock.resume();
  await expect(input).toBeFocused();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(app.getByTestId("terminal-app")).toHaveAttribute("data-terminal-phase", "ended");
  await expect(trigger).toHaveAttribute("data-state", "closed");
});

test("quick settings returns keyboard focus to its trigger when no other input was selected", async ({
  page,
}) => {
  await signIn(page);
  const trigger = page.getByRole("button", { name: "Hızlı ayarlar", exact: true });
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
