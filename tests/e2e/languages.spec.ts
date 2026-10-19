import { expect, test } from "@playwright/test";
import { resources } from "../../packages/i18n/src/index.ts";
import { CSRF_HEADER, SUPPORTED_LOCALES } from "../../packages/shared/src/index.ts";
import { signIn } from "./helpers.ts";

test("every language loads on demand and the sign-in page switches to it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: resources.en.login.title })).toBeVisible();
  let current = resources.en;
  for (const locale of SUPPORTED_LOCALES.filter((code) => code !== "en")) {
    await page.getByRole("button", { name: current.common.language }).click();
    await page.getByRole("menuitemradio", { name: resources[locale].languages[locale] }).click();
    current = resources[locale];
    await expect(page.getByRole("heading", { name: current.login.title })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.getByLabel(current.login.username)).toBeVisible();
  }
  // The choice is remembered on this device before signing in.
  await page.reload();
  await expect(page.getByRole("heading", { name: current.login.title })).toBeVisible();
});

test("a saved account language opens the desktop in that language", async ({ page }) => {
  const session = await signIn(page);
  const headers = { [CSRF_HEADER]: session.csrfToken };
  try {
    for (const locale of SUPPORTED_LOCALES) {
      expect(
        (await page.request.patch("/api/account", { headers, data: { locale } })).status(),
      ).toBe(200);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(
        page
          .getByTestId("dock")
          .getByRole("button", { name: resources[locale].apps.settings, exact: true }),
      ).toBeVisible();
    }
    await page
      .getByTestId("dock")
      .getByRole("button", { name: resources.zh.apps.settings, exact: true })
      .click();
    const settings = page.locator('[data-app-id="everyos.settings"]');
    await settings
      .getByRole("button", { name: resources.zh.settings.sections.account, exact: true })
      .click();
    await expect(settings).toContainText(resources.zh.settings.account.translationNotice);
    await settings
      .getByRole("combobox", { name: resources.zh.settings.account.language })
      .selectOption("en");
    await expect(settings).not.toContainText(resources.en.settings.account.translationNotice);
  } finally {
    await page.request.patch("/api/account", { headers, data: { locale: "tr" } });
  }
});
