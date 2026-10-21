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
  test.setTimeout(90_000);
  await page.goto("/");
  await page.getByLabel(/Kullanıcı adı|Username/).fill("goktug");
  await page.getByLabel(/^(Parola|Password)$/).fill(PASSWORD);
  await page.getByRole("button", { name: /Giriş yap|Sign in/ }).click();
  await expect(page.getByTestId("desktop")).toBeVisible();
  expect(await page.evaluate(() => window.isSecureContext)).toBe(
    !process.env.EVERYOS_E2E_HTTP_HOST,
  );
  expect(await call(page, "POST", "/api/desktop-apps/registries/official/sync", {})).toBe(200);
  try {
    // Installed from the store: its sensitive permission has to be ticked before Install works.
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("mağaza");
    await page.keyboard.press("Enter");
    const store = page.locator('[data-app-id="everyos.store"]');
    await expect(store).toBeVisible();
    await store.getByLabel("Tür", { exact: true }).selectOption("desktop");
    await store
      .locator('[data-testid="desktop-app-listing"][data-app-id="dev.everyos.probe"]')
      .click();
    const details = page.getByTestId("desktop-app-dialog");
    await expect(details).toContainText("Masaüstü uygulaması");
    await expect(details.getByTestId("desktop-app-permissions")).toContainText(
      "Seçtiğiniz dosyaları açma",
    );
    const install = details.getByRole("button", { name: "Kur", exact: true });
    await expect(install).toBeDisabled();
    await details.getByRole("checkbox", { name: "Klasör boyutlarını ölçme" }).check();
    await expect(install).toBeDisabled();
    await details.getByRole("checkbox", { name: "Görünümünüzü değiştirme" }).check();
    await install.click();
    await details.getByRole("button", { name: "Aç", exact: true }).click();
    await expect(details).toHaveCount(0);
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
    // Refused by the server itself: the probe was never granted system metrics.
    await expect(probe("forbidden")).toHaveText("FORBIDDEN");

    // A dialog the desktop draws for the app, over the app's window only.
    await frame.getByRole("button", { name: "Ask" }).click();
    const dialog = window.getByRole("alertdialog");
    await expect(dialog).toContainText("Deneme notu silinsin mi?");
    await dialog.getByRole("button", { name: "Onayla" }).click();
    await expect(probe("answer")).toHaveText("confirmed");

    // Files: only what the person picks in the desktop's picker reaches the app.
    expect(
      await page.evaluate(async (header) => {
        const session = (await (await fetch("/api/auth/session")).json()) as { csrfToken: string };
        const response = await fetch(
          "/api/files/upload?root=home&path=Belgeler&name=probe-input.txt",
          { method: "POST", headers: { [header]: session.csrfToken }, body: "picked by a person" },
        );
        return response.status;
      }, CSRF_HEADER),
    ).toBe(201);
    await frame.getByRole("button", { name: "Open file" }).click();
    const picker = window.getByTestId("desktop-app-file-picker");
    await expect(picker).toContainText("Dosya aç");
    await picker.getByRole("option", { name: "probe-input.txt" }).click();
    await picker.getByRole("button", { name: "Aç" }).click();
    await expect(probe("opened")).toHaveText("picked by a person");
    await frame.getByRole("button", { name: "Save file" }).click();
    await expect(picker).toContainText("Farklı kaydet");
    await picker.getByRole("button", { name: "Kaydet" }).click();
    await expect(probe("saved")).toHaveText("20");
    expect(
      await page.evaluate(async () => {
        const response = await fetch("/api/files/text?root=home&path=Belgeler/probe-output.txt");
        return ((await response.json()) as { content: string }).content;
      }),
    ).toBe("written by the probe");

    // Appearance: the app sets the person's wallpaper through the desktop, and gets previews.
    await frame.getByRole("button", { name: "Wallpaper" }).click();
    await expect(probe("wallpaper")).toHaveText('{"kind":"solid","color":"#123456"}');
    await expect(probe("preview")).toHaveText("image/png 64x40");
    await expect(probe("appearanceChanged")).toHaveText("yes");
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const response = await fetch("/api/preferences");
          const body = (await response.json()) as {
            preferences: { appearance?: { wallpaper?: unknown } };
          };
          return JSON.stringify(body.preferences.appearance?.wallpaper ?? null);
        }),
      )
      .toBe('{"kind":"solid","color":"#123456"}');

    // Its data survives closing the window, and the launcher knows it by its Turkish name.
    await window.getByRole("button", { name: "Kapat" }).first().click();
    await expect(window).toHaveCount(0);
    await openFromLauncher(page);
    await expect(probe("runs")).toHaveText("2");

    // Uninstalled from the store, after a confirmation; the launcher no longer offers it.
    await window.getByRole("button", { name: "Kapat" }).first().click();
    await expect(window).toHaveCount(0);
    await store
      .locator('[data-testid="desktop-app-listing"][data-app-id="dev.everyos.probe"]')
      .click();
    await expect(details).toContainText("Klasör boyutlarını ölçme");
    await details.getByRole("button", { name: "Kaldır", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Sonda kaldırılsın mı?");
    await confirm.getByRole("button", { name: "Kaldır", exact: true }).click();
    await expect(details).toHaveCount(0);
    expect(await call(page, "GET", "/api/desktop-apps/installed/dev.everyos.probe/settings")).toBe(
      404,
    );
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("Sonda");
    await expect(page.getByRole("option", { name: /Sonda/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
  } finally {
    // Leaves nothing behind when a step above failed.
    await call(page, "POST", "/api/files/delete", {
      root: "home",
      paths: ["Belgeler/probe-input.txt", "Belgeler/probe-output.txt"],
      confirm: true,
    });
    await call(page, "DELETE", "/api/desktop-apps/installed/dev.everyos.probe", { confirm: true });
  }
});

test("administrators scope the network access of apps in the store", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel(/Kullanıcı adı|Username/).fill("goktug");
  await page.getByLabel(/^(Parola|Password)$/).fill(PASSWORD);
  await page.getByRole("button", { name: /Giriş yap|Sign in/ }).click();
  await expect(page.getByTestId("desktop")).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("mağaza");
  await page.keyboard.press("Enter");
  const store = page.locator('[data-app-id="everyos.store"]');
  await store.getByRole("tab", { name: "Katalog kaynakları", exact: true }).click();
  const rules = store.getByTestId("desktop-app-network-rules");
  await expect(rules).toContainText("Henüz izin verilen bir adres yok.");

  await rules.getByLabel("Tür", { exact: true }).selectOption("cidr");
  await rules.getByLabel("Adres", { exact: true }).fill("192.168.1.0/24");
  await rules.getByLabel("Portlar", { exact: true }).fill("80, 8123");
  await rules.getByLabel("Not (isteğe bağlı)").fill("Home Assistant");
  await rules.getByRole("button", { name: "İzin ver", exact: true }).click();
  await expect(rules.getByRole("listitem")).toHaveCount(1);
  await expect(rules.getByRole("listitem")).toContainText("192.168.1.0/24");
  await expect(rules.getByRole("listitem")).toContainText("Portlar 80, 8123");
  await expect(rules.getByRole("listitem")).toContainText("Tüm uygulamalar");
  // An unusable range is refused by the server with a readable reason.
  await rules.getByLabel("Adres", { exact: true }).fill("0.0.0.0/0");
  await rules.getByRole("button", { name: "İzin ver", exact: true }).click();
  await expect(rules.getByRole("alert")).toBeVisible();
  await expect(rules.getByRole("listitem")).toHaveCount(1);

  await rules.getByRole("button", { name: "Kaldır", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("192.168.1.0/24 kuralı kaldırılsın mı?");
  await confirm.getByRole("button", { name: "Kaldır", exact: true }).click();
  await expect(rules).toContainText("Henüz izin verilen bir adres yok.");
});
