import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";
import type { SelfUpdateStatus } from "../../packages/shared/src/index.ts";

test("EveryOS installation confirms and prepares a backup without requesting a password", async ({
  page,
}) => {
  await signIn(page);
  const status = (await (await page.request.get("/api/self-update")).json()) as SelfUpdateStatus;
  // Only discovery is a fixture: backup and install requests reach the real development API.
  const discovery = {
    ...status,
    configured: true,
    reason: null,
    job: null,
    available: {
      version: "0.2.0",
      minVersion: status.installedVersion,
      schemaVersion: 1,
      notes: "Browser test release discovery fixture",
      publishedAt: Date.now(),
    },
  } satisfies SelfUpdateStatus;
  await page.route("**/api/self-update", (route) => route.fulfill({ json: discovery }));
  await page.route("**/api/events?**", (route) => {
    const topics = new URL(route.request().url()).searchParams.get("topics")?.split(",") ?? [];
    return topics.includes("release")
      ? route.fulfill({
          contentType: "text/event-stream",
          body: `event: ready\ndata: {}\n\nevent: release.status\ndata: ${JSON.stringify(discovery)}\n\n`,
        })
      : route.continue();
  });
  await page.getByTestId("dock").getByRole("button", { name: "Ayarlar", exact: true }).click();
  const settings = page.locator('[data-app-id="everyos.settings"]');
  await settings.getByRole("button", { name: "Hakkında", exact: true }).click();
  const panel = settings.getByTestId("self-update-panel");
  await expect(panel).toContainText("Yeni sürümler beş dakikada bir otomatik denetlenir");
  await expect(panel).toContainText("Son denetim");
  await expect(panel.locator('input[type="password"]')).toHaveCount(0);
  const install = panel.getByRole("button", { name: "Güncellemeyi yükle", exact: true });
  await expect(install).toBeEnabled();
  const request = page.waitForRequest((value) => value.url().endsWith("/api/self-update/install"));
  const response = page.waitForResponse((value) =>
    value.url().endsWith("/api/self-update/install"),
  );
  await install.click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("0.2.0");
  await confirm.getByRole("button", { name: "Güncellemeyi yükle", exact: true }).click();
  expect((await request).postDataJSON()).toEqual({
    version: "0.2.0",
    backupId: expect.stringMatching(/^\d{8}-\d{6}-[a-f0-9]{6}$/),
    confirm: true,
  });
  // The production-only agent policy must still deny actual package installation here.
  expect((await response).status()).toBe(403);
  await expect(install).toBeEnabled();
});

test("pending updates are listed, inspected and upgraded only after confirmation", async ({
  page,
}) => {
  await signIn(page);
  await page.getByTestId("dock").getByRole("button", { name: "Ayarlar", exact: true }).click();
  const settings = page.locator('[data-app-id="everyos.settings"]');
  await settings.getByRole("button", { name: "Hakkında", exact: true }).click();
  const aboutUpdate = settings.getByTestId("settings-about").getByTestId("self-update-panel");
  const status = (await (await page.request.get("/api/self-update")).json()) as SelfUpdateStatus;
  await expect(aboutUpdate.getByText(status.installedVersion, { exact: true })).toBeVisible();
  await expect(aboutUpdate).toContainText("Sürüm güncellemeleri geliştirme modunda kullanılamaz.");
  await expect(
    aboutUpdate.getByRole("button", { name: "Güncellemeleri denetle", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("güncelleme");
  await page.getByRole("option", { name: "Güncellemeler" }).click();
  const app = page.locator('[data-app-id="everyos.updates"]');
  await app.getByRole("tab", { name: "EveryOS", exact: true }).click();
  await expect(app.getByTestId("self-update-panel")).toContainText(
    "Sürüm güncellemeleri geliştirme modunda kullanılamaz.",
  );
  await expect(
    app.getByRole("button", { name: "Güncellemeleri denetle", exact: true }),
  ).toBeDisabled();
  await app.getByRole("tab", { name: "Paketler", exact: true }).click();
  await expect(app.getByTestId("updates-app")).toContainText("5 güncelleme bekliyor");
  await expect(app).toContainText("2 güvenlik");
  // The e2e agent answers from the apt simulator and says so.
  await expect(app.getByTestId("simulated-badge")).toBeVisible();

  const rows = app.getByTestId("update-row");
  await rows.filter({ hasText: "openssl" }).click();
  await expect(app.getByTestId("package-details")).toContainText("3.0.13-0ubuntu3.6");
  await expect(app.getByTestId("package-details")).toContainText("Güvenlik güncellemesi");

  await app.getByRole("checkbox", { name: "curl paketini seç" }).check();
  await app.getByRole("button", { name: "Seçilenleri güncelle (1)" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("hiçbir paket kaldırılmaz");
  await confirm.getByRole("button", { name: "Güncelle", exact: true }).click();
  await expect(app.getByTestId("update-job")).toContainText("1 paket güncellendi");
  await expect(app.getByTestId("update-job")).toContainText("Setting up curl");
  await expect(rows.filter({ hasText: "curl" })).toHaveCount(0);
  await expect(app.getByTestId("updates-app")).toContainText("4 güncelleme bekliyor");
  await expect(app.getByRole("button", { name: "Listeleri yenile", exact: true })).toBeEnabled();
  await expect(app.getByRole("button", { name: "Tümünü güncelle", exact: true })).toBeEnabled();

  // Completion must reach the parent even while the log is hidden and SSE is unavailable.
  await page.route("**/api/updates/jobs/*/events", (route) => route.abort());
  await app.getByRole("button", { name: "Listeleri yenile", exact: true }).click();
  await app.getByRole("tab", { name: "Geçmiş" }).click();
  await expect(app).toContainText("Paket listeleri yenilendi");
  await app.getByRole("tab", { name: "Paketler", exact: true }).click();
  await expect(app.getByTestId("update-job")).toContainText("Paket listeleri yenilendi");
  await expect(app.getByRole("button", { name: "Listeleri yenile", exact: true })).toBeEnabled();
  await expect(app.getByRole("button", { name: "Tümünü güncelle", exact: true })).toBeEnabled();
  await app.getByRole("checkbox", { name: "tzdata paketini seç" }).check();
  await app.getByRole("button", { name: "Seçilenleri güncelle (1)" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Güncelle", exact: true })
    .click();
  await expect(app.getByTestId("update-job")).toContainText("1 paket güncellendi");
  await expect(rows.filter({ hasText: "tzdata" })).toHaveCount(0);
  await expect(app.getByRole("button", { name: "Listeleri yenile", exact: true })).toBeEnabled();

  await app.getByRole("tab", { name: "Geçmiş" }).click();
  await expect(app).toContainText("1 paket güncellendi");
  await expect(app).toContainText("curl");
});
