import { expect, test, type Page } from "@playwright/test";
import { CSRF_HEADER } from "../../packages/shared/src/index.ts";
import { signIn } from "./helpers.ts";

async function launch(page: Page, query: string) {
  await page
    .getByTestId("dock")
    .getByRole("button", { name: "Tüm uygulamalar", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill(query);
  await page.getByRole("option").filter({ hasText: query }).first().click();
}

async function removeCalculator(page: Page): Promise<number | null> {
  return page.evaluate(async (header) => {
    const response = await fetch("/api/auth/session", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const session = (await response.json()) as { csrfToken: string };
    const removed = await fetch("/api/desktop-apps/installed/dev.everyos.calculator", {
      method: "DELETE",
      headers: { [header]: session.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
      signal: AbortSignal.timeout(5000),
    });
    return removed.status;
  }, CSRF_HEADER);
}

test.afterEach(async ({ page }) => {
  const status = await removeCalculator(page);
  if (status !== null) expect([204, 404]).toContain(status);
});

test("new SDK apps get immediate Dock shortcuts and application list context actions", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const id = "dev.everyos.calculator";
  const windowId = `everyos.desktop.${id}`;
  expect([204, 404]).toContain(await removeCalculator(page));
  await launch(page, "Mağaza");
  const store = page.locator('[data-app-id="everyos.store"]');
  await store.getByLabel("Tür", { exact: true }).selectOption("desktop");
  await store.locator(`[data-testid="desktop-app-listing"][data-app-id="${id}"]`).click();
  const details = page.getByTestId("desktop-app-dialog");
  await details.getByRole("button", { name: "Kur", exact: true }).click();
  await details.getByRole("button", { name: "Aç", exact: true }).click();
  const appWindow = page.locator(`[data-app-id="${windowId}"]`);
  await expect(appWindow.getByTestId("desktop-app-frame")).toHaveAttribute("data-phase", "ready");
  const name = "Hesap Makinesi";
  const dock = page.getByTestId("dock");
  const dockApp = dock.locator(`[data-dock-item="${windowId}"]`).getByRole("button");
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await dockApp.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Masaüstüne kısayol ekle", exact: true }).click();
  const shortcut = page.getByTestId("desktop-surface").getByRole("button", { name, exact: true });
  await expect(shortcut).toBeVisible();
  expect(navigations).toBe(0);

  await dock.getByRole("button", { name: "Uygulama Mağazası", exact: true }).click();
  await store.getByRole("tab", { name: "Kurulu uygulamalar", exact: true }).click();
  await store
    .getByTestId("desktop-apps-installed")
    .getByRole("button", { name: /Hesap Makinesi/ })
    .click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Aç", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Kaldır", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await launch(page, "Uygulamalar");
  const folder = page.getByTestId("applications-folder");
  const app = folder.getByRole("option", { name, exact: true });
  await expect(app).toBeVisible();
  await app.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Aç", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Masaüstüne ekle", exact: true })).toBeDisabled();
  await page.getByRole("menuitem", { name: "Dock'a ekle", exact: true }).click();
  await dockApp.click();
  await appWindow.getByRole("button", { name: "Kapat", exact: true }).first().click();
  await expect(dockApp).toBeVisible();
  await app.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Aç", exact: true }).click();
  await expect(appWindow.getByTestId("desktop-app-frame")).toHaveAttribute("data-phase", "ready");

  // The launcher uses the same actions for freshly installed apps.
  await dock.getByRole("button", { name: "Tüm uygulamalar", exact: true }).click();
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill(name);
  await page.getByRole("option").filter({ hasText: name }).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Dock'tan kaldır", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox", { name: "Uygulama veya komut ara…" })).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "Kaldır", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await dock.getByRole("button", { name: "Uygulamalar", exact: true }).click();
  await app.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Kaldır", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Vazgeç", exact: true }).click();
  await expect(app).toBeVisible();
  await app.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Kaldır", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Kaldır", exact: true }).click();
  await expect(app).toHaveCount(0);
  await expect(shortcut).toHaveCount(0);
  await expect(dockApp).toHaveCount(0);
  await expect(appWindow).toHaveCount(0);
  expect(navigations).toBe(0);
});
