import { expect, test } from "@playwright/test";
import {
  CSRF_HEADER,
  type AppJobView,
  type CatalogAppView,
  type InstalledAppView,
  type DesktopPreferences,
  type FileRootsResponse,
  type PreferenceDocuments,
} from "../../packages/shared/src/index.ts";
import { signIn } from "./helpers.ts";

test("catalog sync, installation, streamed progress and lifecycle work together", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const session = await signIn(page);
  const headers = { [CSRF_HEADER]: session.csrfToken };
  // Stop the active desktop's queued saves before injecting an older document out of band.
  await page.goto("about:blank", { waitUntil: "networkidle" });
  // An older custom desktop gets the applications folder without losing its existing shortcut.
  const legacyDesktop: DesktopPreferences = {
    version: 1,
    desktops: [{ id: "d1", name: "Custom desktop", wallpaper: null }],
    files: [],
    items: [
      {
        kind: "app",
        id: "custom-store",
        appId: "everyos.store",
        desktopId: "d1",
        folderId: null,
        cell: { col: 2, row: 0 },
      },
    ],
  };
  expect(
    (await page.request.put("/api/preferences/desktop", { headers, data: legacyDesktop })).status(),
  ).toBe(204);
  await page.goto("/");
  await expect(
    page.getByTestId("desktop-surface").getByRole("button", { name: "Uygulamalar", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const saved = (await (await page.request.get("/api/preferences")).json()) as {
        preferences: { desktop: DesktopPreferences };
      };
      return saved.preferences.desktop.applicationsFolderAdded;
    })
    .toBe(true);
  const saved = (await (await page.request.get("/api/preferences")).json()) as {
    preferences: { desktop: DesktopPreferences };
  };
  expect(saved.preferences.desktop.items).toContainEqual(legacyDesktop.items[0]);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("mağaza");
  await page.keyboard.press("Enter");
  const store = page.locator('[data-app-id="everyos.store"]');
  await expect(store).toBeVisible();
  await store.getByRole("tab", { name: "Katalog kaynakları", exact: true }).click();
  await store.getByRole("button", { name: "Katalog ekle" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Ad", { exact: true }).fill("Original E2E");
  const port = Number(process.env.EVERYOS_E2E_PORT ?? 7480);
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
  for (const label of ["PUID", "PGID", "TZ"])
    await expect(page.getByRole("dialog").getByLabel(label, { exact: true })).toHaveCount(0);
  await page
    .getByRole("dialog")
    .getByText("Gelişmiş ayarlar (isteğe bağlı)", { exact: true })
    .click();
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
  const installedPayload = (await (await page.request.get("/api/apps")).json()) as {
    apps: InstalledAppView[];
  };
  expect(installedPayload.apps[0]?.ports[0]?.port).toBeGreaterThanOrEqual(1024);
  const firstId = installedPayload.apps[0]!.id;
  const catalogApps = (await (await page.request.get("/api/catalogs/apps")).json()) as {
    apps: CatalogAppView[];
  };
  const fixture = catalogApps.apps.find(
    (entry) => entry.source.format === "casaos-source" || entry.name.tr_TR === "Deneme Uygulaması",
  )!;
  const additional = await page.request.post("/api/apps/install", {
    headers,
    data: {
      appId: fixture.id,
      snapshot: fixture.source.ref,
      variables: {
        APP_TOKEN: "extra-fixture-token",
        SERVICE_PASSWORD_64_DEMO: "extra-fixture-password",
      },
      acknowledgeRisks: true,
    },
  });
  expect(additional.status()).toBe(202);
  const extraJob = (await additional.json()) as AppJobView;
  await page
    .getByTestId("desktop-surface")
    .getByRole("button", { name: "Uygulamalar", exact: true })
    .dblclick();
  const folder = page.locator('[data-app-id="everyos.applications"]');
  const options = folder.getByRole("option", { name: "Deneme Uygulaması", exact: true });
  await expect(options).toHaveCount(2);
  await options.nth(0).click();
  await options.nth(1).click({ modifiers: ["ControlOrMeta"] });
  await expect(folder.locator('[data-installed-app][aria-selected="true"]')).toHaveCount(2);
  const grid = await folder.getByTestId("applications-grid").boundingBox();
  await page.mouse.move(grid!.x + 5, grid!.y + grid!.height - 6);
  await page.mouse.down();
  await page.mouse.move(grid!.x + grid!.width - 10, grid!.y + 4, { steps: 12 });
  await page.mouse.up();
  await expect(folder.locator('[data-installed-app][aria-selected="true"]')).toHaveCount(2);
  await folder.locator(`[data-installed-app="${firstId}"]`).click();
  const firstTile = folder.locator(`[data-installed-app="${firstId}"]`);
  await expect(firstTile).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(firstTile.locator("[data-icon-label]")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  const managedId = `everyos.installed.app-${firstId}`;
  await firstTile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Bilgi", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Deneme Uygulaması");
  await page.getByRole("dialog").getByRole("button", { name: "Kapat", exact: true }).click();
  await firstTile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Dock'a ekle", exact: true }).click();
  await expect(
    page.getByTestId("dock").getByRole("button", { name: "Deneme Uygulaması", exact: true }),
  ).toHaveCount(1);
  await firstTile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Masaüstüne ekle", exact: true }).click();
  await firstTile.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Masaüstüne ekle", exact: true })).toBeDisabled();
  await page.screenshot({
    path: test.info().outputPath("application-context-menu.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await firstTile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Güncelle", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "İmajları güncelle", exact: true })
    .click();
  await expect(folder.getByTestId("app-job-progress")).toContainText("Tamamlandı");
  await folder
    .getByTestId("app-job-progress")
    .getByRole("button", { name: "Bildirimi kapat", exact: true })
    .click();
  await firstTile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Kaldır", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Vazgeç", exact: true }).click();
  expect(
    (
      (await (await page.request.get("/api/apps")).json()) as { apps: InstalledAppView[] }
    ).apps.some((app) => app.id === firstId),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("applications-folder.png"),
    animations: "disabled",
  });
  await folder.getByRole("button", { name: "Kapat", exact: true }).first().click();
  const progress = store.getByTestId("app-job-progress");
  await progress.getByRole("button", { name: "Bildirimi kapat", exact: true }).click();
  await expect(progress).toHaveCount(0);
  // The same live collection is available in Files and does not replace a real homedir folder.
  const roots = (await (await page.request.get("/api/files/roots")).json()) as FileRootsResponse;
  const home = roots.roots.find((entry) => entry.kind === "home")!;
  expect(
    (
      await page.request.post("/api/files/mkdir", {
        headers,
        data: {
          root: home.id,
          path: "",
          name: "Uygulamalar",
        },
      })
    ).status(),
  ).toBe(201);
  await page.getByTestId("dock").getByRole("button", { name: "Dosyalar", exact: true }).click();
  const files = page.locator('[data-app-id="everyos.files"]');
  const sidebar = files.getByTestId("files-sidebar");
  const applications = sidebar.getByRole("button", { name: "Uygulamalar", exact: true });
  await applications.click();
  await expect(applications).toHaveAttribute("aria-current", "location");
  await expect(files.getByTestId("files-title")).toHaveText("Uygulamalar");
  await expect(files.getByRole("option", { name: "Deneme Uygulaması", exact: true })).toHaveCount(
    2,
  );
  await files.locator(`[data-installed-app="${firstId}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Bilgi", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Deneme Uygulaması");
  await page.getByRole("dialog").getByRole("button", { name: "Kapat", exact: true }).click();
  await sidebar.getByRole("button", { name: home.name, exact: true }).click();
  await expect(files.getByTestId("applications-home-entry")).toBeVisible();
  await expect(files.locator('[data-name="Uygulamalar"]')).toBeVisible();
  await files.getByRole("button", { name: "Liste", exact: true }).click();
  await files.getByTestId("applications-home-entry").dblclick();
  await expect(files.getByTestId("applications-folder")).toBeVisible();
  await expect(files.getByRole("option", { name: "Deneme Uygulaması", exact: true })).toHaveCount(
    2,
  );
  await page.screenshot({
    path: test.info().outputPath("applications-in-files.png"),
    animations: "disabled",
  });
  await expect
    .poll(async () => {
      const saved = (await (await page.request.get("/api/preferences")).json()) as {
        preferences: Partial<PreferenceDocuments>;
      };
      return saved.preferences.windows?.windows.some(
        (entry) =>
          entry.appId === "everyos.files" &&
          (entry.appState as { place?: string } | undefined)?.place === "applications",
      );
    })
    .toBe(true);
  // An unavailable listing during restore must not destroy the user's persisted shortcuts.
  await expect
    .poll(async () => {
      const prefs = (
        (await (await page.request.get("/api/preferences")).json()) as {
          preferences: Partial<PreferenceDocuments>;
        }
      ).preferences;
      return (
        prefs.dock?.pinned.includes(managedId) &&
        prefs.desktop?.items.some((item) => item.kind === "app" && item.appId === managedId)
      );
    })
    .toBe(true);
  await page.route("**/api/apps", (route) => route.abort());
  await page.reload();
  await expect(files.getByTestId("applications-folder")).toBeVisible();
  await expect(files.getByTestId("applications-folder").getByRole("alert")).toBeVisible();
  const offlinePrefs = (
    (await (await page.request.get("/api/preferences")).json()) as {
      preferences: Partial<PreferenceDocuments>;
    }
  ).preferences;
  expect(offlinePrefs.dock?.pinned).toContain(managedId);
  expect(
    offlinePrefs.desktop?.items.some((item) => item.kind === "app" && item.appId === managedId),
  ).toBe(true);
  await page.unroute("**/api/apps");
  await files
    .getByTestId("applications-folder")
    .getByRole("button", { name: "Yenile", exact: true })
    .click();
  await expect(files.getByRole("option", { name: "Deneme Uygulaması", exact: true })).toHaveCount(
    2,
  );
  await expect(
    page.getByTestId("dock").getByRole("button", { name: "Deneme Uygulaması", exact: true }),
  ).toHaveCount(1);
  await expect(
    page
      .getByTestId("desktop-surface")
      .getByRole("button", { name: "Deneme Uygulaması", exact: true }),
  ).toHaveCount(1);
  await expect(applications).toHaveAttribute("aria-current", "location");
  await files.getByRole("button", { name: "Geri", exact: true }).click();
  await expect(files.locator('[data-name="Uygulamalar"]')).toBeVisible();
  await expect(files.getByTestId("applications-home-entry")).toBeVisible();
  await files.getByRole("button", { name: "Kapat", exact: true }).first().click();
  // Simulated and stopped installations open genuine management details, never a fabricated URL.
  await page
    .getByTestId("dock")
    .getByRole("button", { name: "Deneme Uygulaması", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Deneme Uygulaması");
  await expect(page.getByRole("dialog").getByTestId("simulated-badge")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Kapat", exact: true }).click();
  await folder.getByRole("button", { name: "Kapat", exact: true }).first().click();
  const app = store.locator(`[data-app-installation="${firstId}"]`);
  await expect(app).toContainText("Çalışıyor");
  await expect(app.getByTestId("simulated-badge")).toBeVisible();
  const payload = await (await page.request.get("/api/apps")).text();
  expect(payload).not.toContain("original-e2e-secret");
  expect(payload).not.toContain("chosen-e2e-login-password");
  await app.getByRole("button", { name: "Durdur", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Durdur", exact: true }).click();
  await expect(app).toContainText("Durduruldu");
  await expect(progress).toContainText("Durdur");
  await progress.getByRole("button", { name: "Bildirimi kapat", exact: true }).click();
  await expect(progress).toHaveCount(0);
  await page.route("**/api/apps/jobs/*/events", (route) => route.abort());
  await app.getByRole("button", { name: "Başlat", exact: true }).click();
  await expect(progress).toContainText("Başlat");
  await progress.getByRole("button", { name: "Bildirimi kapat", exact: true }).click();
  await expect(progress).toHaveCount(0);
  await expect(app).toContainText("Çalışıyor");
  await app.getByRole("button", { name: "İmajları güncelle", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "İmajları güncelle", exact: true })
    .click();
  await expect(progress).toContainText("İmajları güncelle");
  await progress.getByRole("button", { name: "Bildirimi kapat", exact: true }).click();
  await expect(progress).toHaveCount(0);
  await expect(app.getByTestId("app-last-job")).toContainText("İmajları güncelle: Tamamlandı");
  await app
    .getByTestId("app-last-job")
    .getByRole("button", { name: "Bildirimi kapat", exact: true })
    .click();
  await expect(app.getByTestId("app-last-job")).toHaveCount(0);
  await page.reload();
  await expect(store).toBeVisible();
  await store.getByRole("tab", { name: "Kurulu uygulamalar", exact: true }).click();
  await expect(app).toContainText("İmajları güncelle: Tamamlandı");
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
  await page
    .getByTestId("desktop-surface")
    .getByRole("button", { name: "Uygulamalar", exact: true })
    .dblclick();
  await folder.locator(`[data-installed-app="${extraJob.appId}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Kaldır", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Kaldır", exact: true }).click();
  await expect(store).toContainText("Henüz EveryOS ile kurulmuş uygulama yok.", {
    timeout: 10_000,
  });
  await expect(folder).toContainText("Mağazadan kurduğun uygulamalar bu klasörde görünür.");
  await expect(folder.getByRole("option")).toHaveCount(0);
  await expect(
    page.getByTestId("dock").getByRole("button", { name: "Deneme Uygulaması", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByTestId("desktop-surface")
      .getByRole("button", { name: "Deneme Uygulaması", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(async () => {
      const prefs = (
        (await (await page.request.get("/api/preferences")).json()) as {
          preferences: Partial<PreferenceDocuments>;
        }
      ).preferences;
      return (
        !prefs.dock?.pinned.includes(managedId) &&
        !prefs.desktop?.items.some((item) => item.kind === "app" && item.appId === managedId)
      );
    })
    .toBe(true);
  await folder.getByRole("button", { name: "Kapat", exact: true }).first().click();
  // Widgets of an uninstalled app say so and offer removal instead of showing stale data.
  await store.getByRole("button", { name: "Kapat", exact: true }).first().click();
  await expect(store).toHaveCount(0);
  await expect(appWidget).toContainText("Bağlı uygulama kaldırıldı", { timeout: 15_000 });
  await appWidget.getByRole("button", { name: "Kaldır", exact: true }).click();
  await expect(appWidget).toHaveCount(0);
});
