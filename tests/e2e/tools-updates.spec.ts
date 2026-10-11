import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

test("pending updates are listed, inspected and upgraded only after confirmation", async ({
  page,
}) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("güncelleme");
  await page.getByRole("option", { name: "Güncellemeler" }).click();
  const app = page.locator('[data-app-id="otuken.updates"]');
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

  await app.getByRole("tab", { name: "Geçmiş" }).click();
  await expect(app).toContainText("1 paket güncellendi");
  await expect(app).toContainText("curl");
});
