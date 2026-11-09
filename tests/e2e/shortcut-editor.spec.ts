import { expect, test, type Page } from "@playwright/test";
import { preferences, signIn } from "./helpers.ts";
import { makeImage } from "./image-fixture.ts";

async function addFromDesktop(page: Page) {
  await page
    .getByTestId("desktop-surface")
    .click({ button: "right", position: { x: 650, y: 350 } });
  await page.getByRole("menuitem", { name: "Kısayol ekle", exact: true }).click();
  return page.getByRole("dialog", { name: "Kısayol ekle", exact: true });
}

test("manual links and private icons persist; editing updates both placements immediately", async ({
  page,
}) => {
  await signIn(page);
  const dialog = await addFromDesktop(page);
  await dialog.getByRole("tab", { name: "Bağlantı", exact: true }).click();
  await dialog.getByLabel("Kısayol adı", { exact: true }).fill("My server");
  const url = new URL("/api/health", page.url()).href;
  await dialog.getByLabel("Bağlantı adresi", { exact: true }).fill("javascript:alert(1)");
  await expect(dialog.getByRole("button", { name: "Kısayol oluştur", exact: true })).toBeDisabled();
  await dialog.getByLabel("Bağlantı adresi", { exact: true }).fill(url);
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "icon.png",
    mimeType: "image/png",
    buffer: makeImage(32, 32, [48, 120, 230]),
  });
  await expect(dialog.getByLabel("İkon adresi", { exact: true })).toHaveValue(
    /\/api\/folder-icons\/.+\/image/,
  );
  await dialog.getByRole("button", { name: "İkisi de", exact: true }).click();
  await dialog.getByRole("button", { name: "Kısayol oluştur", exact: true }).click();
  const surface = page.getByTestId("desktop-surface");
  const dock = page.getByTestId("dock");
  await expect(surface.getByRole("button", { name: "My server", exact: true })).toBeVisible();
  await expect(dock.getByRole("button", { name: "My server", exact: true })).toBeVisible();
  await expect
    .poll(async () => (await preferences(page)).shortcuts?.entries[0]?.name)
    .toBe("My server");
  await page.reload();
  const shortcut = surface.getByRole("button", { name: "My server", exact: true });
  await expect(shortcut).toBeVisible();
  await expect
    .poll(async () =>
      shortcut
        .locator("img")
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 32),
    )
    .toBe(true);
  const popupEvent = page.waitForEvent("popup");
  await shortcut.dblclick();
  const popup = await popupEvent;
  await expect(popup).toHaveURL(url);
  await popup.close();
  await dock.getByRole("button", { name: "My server", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Kısayolu düzenle", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Kısayolu düzenle", exact: true });
  await edit.getByLabel("Kısayol adı", { exact: true }).fill("Renamed server");
  await edit.getByRole("button", { name: "Değişiklikleri kaydet", exact: true }).click();
  const renamed = surface.getByRole("button", { name: "Renamed server", exact: true });
  await expect(renamed).toBeVisible();
  await expect(dock.getByRole("button", { name: "Renamed server", exact: true })).toBeVisible();
  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Kısayolu kaldır", exact: true }).click();
  await expect(renamed).toHaveCount(0);
  await expect(dock.getByRole("button", { name: "Renamed server", exact: true })).toBeVisible();
  await dock
    .getByRole("button", { name: "Renamed server", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Dock'tan kaldır", exact: true }).click();
  await expect.poll(async () => (await preferences(page)).shortcuts?.entries).toEqual([]);
});

test("Dock opens the common modal; EveryOS shortcuts use native windows and the editor fits narrow screens", async ({
  page,
}) => {
  await signIn(page);
  const dock = page.getByTestId("dock");
  await dock.click({ button: "right", position: { x: 3, y: 3 } });
  await page.getByRole("menuitem", { name: "Kısayol ekle", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Kısayol ekle", exact: true });
  await dialog.getByRole("tab", { name: "EveryOS", exact: true }).click();
  await dialog.getByRole("button", { name: /Ayarlar.*Yerleşik/ }).click();
  await dialog.getByLabel("Kısayol adı", { exact: true }).fill("My settings");
  await dialog.getByRole("button", { name: "Kısayol oluştur", exact: true }).click();
  const shortcut = dock.getByRole("button", { name: "My settings", exact: true });
  await shortcut.click();
  const settings = page.locator('[data-app-id="everyos.settings"]');
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Kapat", exact: true }).first().click();
  await shortcut.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Kısayolu düzenle", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Kısayolu düzenle", exact: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(edit).toBeVisible();
  await expect
    .poll(async () => edit.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);
  await edit
    .getByRole("button", { name: "Değişiklikleri kaydet", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    edit.getByRole("button", { name: "Değişiklikleri kaydet", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: ".dev/shortcut-mobile.png" });
  await page.keyboard.press("Escape");
  await expect(edit).toHaveCount(0);
});

test("Docker discovery fills editable addresses and artwork without container mutations", async ({
  page,
}) => {
  await signIn(page);
  // Controlled Engine response; no real Docker host is contacted by this fixture.
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: [] } }));
  await page.route("**/api/docker/containers", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      json: {
        source: "host",
        containers: [
          {
            id: "a".repeat(64),
            name: "Fixture dashboard",
            image: "fixture/dashboard:1",
            imageId: "sha256:fixture",
            state: "running",
            status: "Up",
            health: "none",
            createdAt: 1,
            ports: [{ privatePort: 80, publicPort: 8181, type: "tcp", ip: "0.0.0.0" }],
            project: null,
            service: null,
            networks: ["bridge"],
            managerHint: null,
            protected: false,
            webUiTemplate: "http://[IP]:[PORT:80]/dashboard",
            icon: "https://art.example.test/icon.png",
          },
        ],
      },
    });
  });
  await page.route("https://art.example.test/icon.png", (route) =>
    route.fulfill({ contentType: "image/png", body: makeImage(32, 32, [130, 80, 220]) }),
  );
  const dialog = await addFromDesktop(page);
  await dialog.getByRole("button", { name: /Fixture dashboard/ }).click();
  await expect(dialog.getByLabel("Bağlantı adresi", { exact: true })).toHaveValue(
    "http://127.0.0.1:8181/dashboard",
  );
  await expect(dialog.getByLabel("İkon adresi", { exact: true })).toHaveValue(
    "https://art.example.test/icon.png",
  );
  await expect
    .poll(async () =>
      dialog
        .getByLabel("Kısayol önizlemesi")
        .locator("img")
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 32),
    )
    .toBe(true);
  await page.screenshot({ path: ".dev/shortcut-docker.png" });
  const changed = new URL("/api/health", page.url()).href;
  await dialog.getByLabel("Bağlantı adresi", { exact: true }).fill(changed);
  await dialog.getByRole("button", { name: "Kısayol oluştur", exact: true }).click();
  await expect(
    page
      .getByTestId("desktop-surface")
      .getByRole("button", { name: "Fixture dashboard", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await preferences(page)).shortcuts?.entries[0]?.target)
    .toEqual({ kind: "url", url: changed });
});
