import { expect, test } from "@playwright/test";
import { CSRF_HEADER } from "../../packages/shared/src/index.ts";
import { signIn } from "./helpers.ts";

test("catalog sync, installation, streamed progress and lifecycle work together", async ({
  page,
}) => {
  const session = await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("mağaza");
  await page.keyboard.press("Enter");
  const store = page.locator('[data-app-id="otuken.store"]');
  await expect(store).toBeVisible();
  await store.getByRole("tab", { name: "Katalog kaynakları", exact: true }).click();
  await store.getByRole("button", { name: "Katalog ekle" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Ad", { exact: true }).fill("Original E2E");
  const port = Number(process.env.OTUKEN_E2E_PORT ?? 7480);
  await dialog.getByLabel("Kaynak URL’si").fill(`http://127.0.0.1:${port + 1}/catalog.yml`);
  await dialog.getByLabel("Özel ağ adreslerinden indirmeye izin ver").check();
  await dialog.getByRole("button", { name: "Katalog ekle" }).click();
  const catalog = store.locator("article").filter({ hasText: "Original E2E" });
  await catalog.getByRole("button", { name: "Senkronize et" }).click();
  await expect(catalog).toContainText("1 uygulama");
  await store.getByRole("tab", { name: "Katalog", exact: true }).click();
  await store.getByRole("button", { name: /Deneme Uygulaması/ }).click();
  await expect(page.getByRole("dialog")).toContainText("${APP_DATA_DIR}/data → /data");
  await expect(page.getByRole("dialog")).toContainText("Salt okunur");
  await page
    .getByRole("dialog")
    .getByLabel("SERVICE_PASSWORD_64_DEMO", { exact: true })
    .fill("chosen-e2e-login-password");
  await page
    .getByRole("dialog")
    .getByLabel("APP_TOKEN", { exact: true })
    .fill("original-e2e-secret-$value");
  await page.getByRole("dialog").getByRole("button", { name: "Kur", exact: true }).click();
  await expect(store).toContainText("Tamamlandı");
  // A finished installation offers the app's widgets.
  const offer = page.getByTestId("widget-offer");
  await expect(offer).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Kullanılabilir widget'lar");
  await offer
    .locator('[data-widget="docker.app"]')
    .getByRole("button", { name: "Ekle", exact: true })
    .click();
  await expect(offer.locator('[data-widget="docker.app"]')).toContainText("eklendi");
  await page.getByRole("dialog").getByRole("button", { name: "Şimdi değil" }).click();
  await expect(offer).toBeHidden();
  const appWidget = page.locator('[data-testid="desktop-widget"]').filter({
    has: page.locator('[data-widget="docker.app"]'),
  });
  await expect(appWidget).toContainText("Deneme Uygulaması");
  const app = store.locator("article").filter({ hasText: "Deneme Uygulaması" });
  await expect(app).toContainText("Çalışıyor");
  await expect(app.getByTestId("simulated-badge")).toBeVisible();
  const payload = await (await page.request.get("/api/apps")).text();
  expect(payload).not.toContain("original-e2e-secret");
  expect(payload).not.toContain("chosen-e2e-login-password");
  await app.getByRole("button", { name: "Durdur", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Durdur", exact: true }).click();
  await expect(app).toContainText("Durduruldu");
  await app.getByRole("button", { name: "Başlat", exact: true }).click();
  await expect(app).toContainText("Çalışıyor");
  await page.reload();
  await expect(store).toBeVisible();
  await store.getByRole("tab", { name: "Kurulu uygulamalar", exact: true }).click();
  await expect(app).toContainText("Başlat: Tamamlandı");
  const reconciliation = page.waitForResponse(
    (response) => response.url().endsWith("/reconcile") && response.request().method() === "POST",
  );
  await app.getByRole("button", { name: "Gerçek durumu uzlaştır", exact: true }).click();
  expect((await reconciliation).status()).toBe(200);
  await expect(app).toContainText("Çalışıyor");
  const catalogs = (await (await page.request.get("/api/catalogs")).json()) as {
    catalogs: { id: string; name: string }[];
  };
  const source = catalogs.catalogs.find((entry) => entry.name === "Original E2E")!;
  expect(
    (
      await page.request.delete(`/api/catalogs/${source.id}`, {
        headers: { [CSRF_HEADER]: session.csrfToken },
        data: {},
      })
    ).status(),
  ).toBe(204);
  await page.screenshot({
    path: test.info().outputPath("app-store-installed.png"),
    animations: "disabled",
  });
  await app.getByRole("button", { name: "Kaldır", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Kaldır", exact: true }).click();
  await expect(store).toContainText("Henüz Otuken ile kurulmuş uygulama yok.");
  // Widgets of an uninstalled app say so and offer removal instead of showing stale data.
  await store.getByRole("button", { name: "Kapat", exact: true }).first().click();
  await expect(store).toHaveCount(0);
  await expect(appWidget).toContainText("Bağlı uygulama kaldırıldı", { timeout: 15_000 });
  await appWidget.getByRole("button", { name: "Kaldır", exact: true }).click();
  await expect(appWidget).toHaveCount(0);
});
