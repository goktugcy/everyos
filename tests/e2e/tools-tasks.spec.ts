import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

test("scheduled tasks are created from predefined actions, run on demand and keep history", async ({
  page,
}) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("zamanlanmış");
  await page.getByRole("option", { name: "Zamanlanmış Görevler" }).click();
  const app = page.locator('[data-app-id="everyos.tasks"]');
  await expect(app.getByTestId("tasks-app")).toContainText("Henüz zamanlanmış görev yok.");

  await app.getByRole("button", { name: "Görev ekle" }).click();
  const dialog = page.getByRole("dialog", { name: "Görev ekle" });
  await dialog.getByLabel("İşlem").selectOption("updates.refresh");
  await dialog.getByLabel("Ad", { exact: true }).fill("Gece liste yenileme");
  await dialog.getByLabel("Tekrar").selectOption("weekly");
  await dialog.getByLabel("Gün", { exact: true }).selectOption("1");
  await dialog.getByLabel("Saat").fill("04:15");
  await expect(dialog).toContainText("Sonraki çalışma:");
  // An invalid custom expression cannot be saved.
  await dialog.getByLabel("Tekrar").selectOption("custom");
  await dialog.getByLabel("Cron ifadesi").fill("99 * * * *");
  await expect(dialog).toContainText("Bu zamanlama geçersiz");
  await expect(dialog.getByRole("button", { name: "Kaydet" })).toBeDisabled();
  await dialog.getByLabel("Cron ifadesi").fill("15 4 * * 1");
  await dialog.getByRole("button", { name: "Kaydet" }).click();

  const row = app.getByTestId("task-row").filter({ hasText: "Gece liste yenileme" });
  await expect(row).toContainText("Her Pazartesi 04:15");
  await row.getByRole("button", { name: "Şimdi çalıştır" }).click();
  await expect(row).toContainText("Başarılı");
  await row.getByRole("button", { name: /Gece liste yenileme/ }).click();
  await expect(app.getByTestId("task-runs")).toContainText("Elle");

  await row.getByRole("switch", { name: "Etkin" }).click();
  await expect(row.getByRole("switch", { name: "Etkin" })).not.toBeChecked();
  await row.getByRole("button", { name: "Sil" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sil" }).click();
  await expect(row).toHaveCount(0);
});
