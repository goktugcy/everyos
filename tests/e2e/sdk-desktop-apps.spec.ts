import { expect, test, type Page } from "@playwright/test";
import { CSRF_HEADER } from "../../packages/shared/src/index.ts";
import { PASSWORD } from "./helpers.ts";

/*
 * A real desktop app (tests/e2e/fixtures/probe-app, built with the SDK and installed from the
 * signed fixture registry) in a real browser. Everything goes through the page, so the test also
 * runs over plain HTTP with EVERYOS_E2E_HTTP_HOST (not a secure context, like the owner's setup).
 */

/** An API call made by the signed-in page itself (CSRF token included). */
function call(page: Page, method: string, path: string, body?: unknown): Promise<number> {
  return page.evaluate(
    async ({ method, path, body, header }) => {
      const session = (await (await fetch("/api/auth/session")).json()) as { csrfToken: string };
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json", [header]: session.csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return response.status;
    },
    { method, path, body, header: CSRF_HEADER },
  );
}

async function openFromLauncher(page: Page) {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("Sonda");
  await page.keyboard.press("Enter");
}

test("a desktop app runs sandboxed, keeps its data and cannot reach the desktop", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel(/Kullanıcı adı|Username/).fill("goktug");
  await page.getByLabel(/^(Parola|Password)$/).fill(PASSWORD);
  await page.getByRole("button", { name: /Giriş yap|Sign in/ }).click();
  await expect(page.getByTestId("desktop")).toBeVisible();
  expect(await page.evaluate(() => window.isSecureContext)).toBe(
    !process.env.EVERYOS_E2E_HTTP_HOST,
  );
  expect(await call(page, "POST", "/api/desktop-apps/registries/official/sync", {})).toBe(200);
  expect(
    await call(page, "POST", "/api/desktop-apps/installed", {
      registryId: "official",
      appId: "dev.everyos.probe",
    }),
  ).toBe(201);
  try {
    await page.reload();
    await expect(page.getByTestId("desktop")).toBeVisible();
    // The launcher knows the app by its own Turkish name.
    await openFromLauncher(page);
    const window = page.locator('[data-app-id="everyos.desktop.dev.everyos.probe"]');
    await expect(window).toBeVisible();
    const frame = window.frameLocator('[data-testid="desktop-app-frame"]');
    const probe = (name: string) => frame.locator(`[data-probe="${name}"]`);

    await expect(probe("connected")).toHaveText("yes");
    await expect(probe("runs")).toHaveText("1");
    await expect(probe("locale")).toHaveText("tr");
    await expect(window).toContainText("Sonda ready");
    // The sandbox: no parent DOM, no cookies, no storage of the origin, no API.
    for (const name of ["parentDom", "cookie", "localStorage", "api"])
      await expect(probe(name), name).toHaveText("blocked");
    await expect(probe("forbidden")).toHaveText(/^(EVERYOS_|FORBIDDEN)/);

    // A dialog the desktop draws for the app, over the app's window only.
    await frame.getByRole("button", { name: "Ask" }).click();
    const dialog = window.getByRole("alertdialog");
    await expect(dialog).toContainText("Deneme notu silinsin mi?");
    await dialog.getByRole("button", { name: "Onayla" }).click();
    await expect(probe("answer")).toHaveText("confirmed");

    // Its data survives closing the window.
    await window.getByRole("button", { name: "Kapat" }).first().click();
    await expect(window).toHaveCount(0);
    await openFromLauncher(page);
    await expect(probe("runs")).toHaveText("2");
  } finally {
    expect(
      await call(page, "DELETE", "/api/desktop-apps/installed/dev.everyos.probe", {
        confirm: true,
      }),
    ).toBe(204);
  }
});
