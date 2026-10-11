import { expect, test } from "@playwright/test";
import { CSRF_HEADER } from "../../packages/shared/src/index.ts";
import { PASSWORD, preferences, signIn } from "./helpers.ts";

test("backups are created, verified, downloaded and restored with a safety backup", async ({
  page,
}) => {
  const session = await signIn(page);
  const headers = { [CSRF_HEADER]: session.csrfToken };
  const quiet = { version: 1, toasts: false, toastMinSeverity: "critical", mutedCategories: [] };
  expect(
    (await page.request.put("/api/preferences/notifications", { headers, data: quiet })).status(),
  ).toBe(204);

  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("yedek");
  await page.getByRole("option", { name: "Yedekler" }).click();
  const app = page.locator('[data-app-id="otuken.backups"]');
  await expect(app.getByTestId("backups-app")).toContainText("Henüz yedek yok.");
  await expect(app.getByTestId("backup-storage")).toContainText("Konum:");

  await app.getByRole("button", { name: "Yedek al" }).click();
  const create = page.getByRole("dialog", { name: "Yedek al" });
  await create.getByLabel("Not").fill("e2e yedeği");
  await create.getByRole("button", { name: "Yedeklemeyi başlat" }).click();
  const row = app.getByTestId("backup-row").filter({ hasText: "e2e yedeği" });
  await expect(row).toContainText("Doğrulandı");
  await expect(row).toContainText("Veritabanı");

  // Change the preference after the backup, then bring the backed-up desktop back.
  expect(
    (
      await page.request.put("/api/preferences/notifications", {
        headers,
        data: { ...quiet, toasts: true },
      })
    ).status(),
  ).toBe(204);
  await row.getByRole("button", { name: "Geri yükle" }).click();
  const restore = page.getByRole("dialog", { name: "Yedekten geri yükle" });
  await expect(restore).toContainText("Yedek doğrulandı");
  await restore.getByLabel(/Masaüstü ve tercihler/).check();
  await restore.getByLabel("Parolanız").fill(PASSWORD);
  await expect(restore.getByRole("button", { name: "Geri yükle" })).toBeDisabled();
  await restore.getByLabel("Seçilen verilerin değiştirileceğini anladım.").check();
  await restore.getByRole("button", { name: "Geri yükle" }).click();
  await expect(app.getByTestId("backup-restored")).toContainText("Geri yükleme tamamlandı");
  expect((await preferences(page)).notifications).toEqual(quiet);
  const safety = app
    .getByTestId("backup-row")
    .filter({ hasText: "Geri yükleme öncesi güvenlik yedeği" });
  await expect(safety).toHaveCount(1);

  // Downloads need the password and arrive as one tar archive.
  await row.getByRole("button", { name: "İndir" }).click();
  const download = page.getByRole("dialog", { name: "İndir" });
  await download.getByLabel("Parolanız").fill("yanlis-parola-123");
  await download.getByRole("button", { name: "İndir" }).click();
  await expect(download).toContainText("Mevcut parola hatalı");
  await download.getByLabel("Parolanız").fill(PASSWORD);
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    download.getByRole("button", { name: "İndir" }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^otuken-backup-\d{8}-\d{6}-[a-f0-9]{6}\.tar$/);

  await safety.getByRole("button", { name: "Sil", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sil" }).click();
  await expect(safety).toHaveCount(0);
});
