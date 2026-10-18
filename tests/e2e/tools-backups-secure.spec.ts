import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CSRF_HEADER, diskRootId, type FileListing } from "../../packages/shared/src/index.ts";
import { PASSWORD, signIn } from "./helpers.ts";

const PASSPHRASE = "dag-basinda-sessiz-bir-ev";
const USB = "2f6a3c1e-8b4d-4e7a-9f10-3b5c7d9e1a24";

test("encrypted backups go off-site and come back with the passphrase only", async ({ page }) => {
  const session = await signIn(page);
  const headers = { [CSRF_HEADER]: session.csrfToken };
  expect(
    (
      await page.request.post("/api/system/disks/mount", {
        headers,
        data: { uuid: USB, persistent: false },
      })
    ).status(),
  ).toBe(200);

  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("yedek");
  await page.getByRole("option", { name: "Yedekler" }).click();
  const app = page.locator('[data-app-id="everyos.backups"]');
  await expect(app.getByTestId("backups-app")).toBeVisible();

  // The passphrase first, then a mounted disk as the destination.
  await app.getByRole("button", { name: "Şifreleme ve uzak kopya" }).click();
  const dialog = page.getByRole("dialog", { name: "Şifreleme ve uzak kopya" });
  const passphrase = dialog.getByRole("region", { name: "Yedek parolası" });
  await expect(passphrase).toContainText("Henüz parola belirlenmedi");
  await passphrase.getByLabel("Yeni yedek parolası").fill(PASSPHRASE);
  await passphrase.getByLabel("Parolayı tekrarla").fill(PASSPHRASE);
  await passphrase.getByLabel("Hesap parolan").fill(PASSWORD);
  await passphrase.getByRole("button", { name: "Parolayı kaydet" }).click();
  await expect(passphrase).toContainText("Yedek parolası kaydedildi.");
  await passphrase.getByLabel("Parolayı sına").fill(PASSPHRASE);
  await passphrase.getByRole("button", { name: "Parolayı sına" }).click();
  await expect(passphrase).toContainText("Parola doğru.");

  const target = dialog.getByRole("region", { name: "Uzak hedef" });
  await target.getByRole("combobox", { name: "Uzak hedef" }).selectOption("disk");
  await target.getByRole("combobox", { name: "Disk" }).selectOption(USB);
  await target.getByLabel("Hedefte saklanacak kopya").fill("2");
  await target.getByLabel("Hesap parolan").fill(PASSWORD);
  await target.getByRole("button", { name: "Hedefi doğrula ve kaydet" }).click();
  await expect(target).toContainText("Uzak hedef doğrulandı ve kaydedildi.");
  await page.keyboard.press("Escape");

  // A new backup is copied there, encrypted.
  await app.getByRole("button", { name: "Yedek al" }).click();
  const create = page.getByRole("dialog", { name: "Yedek al" });
  await create.getByLabel("Not").fill("uzak kopya e2e");
  await create.getByRole("button", { name: "Yedeklemeyi başlat" }).click();
  const row = app.getByTestId("backup-row").filter({ hasText: "uzak kopya e2e" });
  await expect(row.getByTestId("backup-offsite")).toContainText("Uzak kopya:", {
    timeout: 20_000,
  });
  const copies = (await (
    await page.request.get(
      `/api/files/list?${new URLSearchParams({ root: diskRootId(USB), path: "EveryOS Backups" }).toString()}`,
    )
  ).json()) as FileListing;
  expect(copies.entries.map((entry) => entry.name)).toEqual([
    expect.stringMatching(/^everyos-backup-\d{8}-\d{6}-[a-f0-9]{6}\.eosbak$/),
  ]);

  // Downloaded encrypted by default.
  await row.getByRole("button", { name: "İndir" }).click();
  const download = page.getByRole("dialog", { name: "İndir" });
  await expect(download.getByTestId("backup-download-encrypted")).toBeChecked();
  await download.getByLabel("Parolanız").fill(PASSWORD);
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    download.getByRole("button", { name: "İndir" }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^everyos-backup-\d{8}-\d{6}-[a-f0-9]{6}\.eosbak$/);
  const path = await file.path();
  expect(readFileSync(path).subarray(0, 8).toString()).toBe("EOSENC01");

  // Gone here; the encrypted file brings it back with the passphrase.
  await row.getByRole("button", { name: "Sil", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sil" }).click();
  await expect(row).toHaveCount(0);
  await app.getByTestId("backup-upload-input").setInputFiles(path);
  const open = page.getByRole("dialog", { name: "Şifreli yedeği aç" });
  await expect(open).toContainText("sunucu anahtarını içeriyor");
  await open.getByLabel("Yedek parolası").fill("bu-parola-degil-ki");
  await open.getByRole("button", { name: "Aç ve içe aktar" }).click();
  await expect(open).toContainText("Yedek parolası bu dosyayı açmıyor.");
  await open.getByLabel("Yedek parolası").fill(PASSPHRASE);
  await open.getByRole("button", { name: "Aç ve içe aktar" }).click();
  await expect(open).toHaveCount(0);
  const imported = app.getByTestId("backup-row").filter({ hasText: "uzak kopya e2e" });
  await expect(imported).toContainText("yüklendi");
  await expect(imported).toContainText("Doğrulandı");

  // Back to how other tests expect it: no destination, no passphrase, no disk.
  await app.getByRole("button", { name: "Şifreleme ve uzak kopya" }).click();
  await target.getByRole("combobox", { name: "Uzak hedef" }).selectOption("none");
  await target.getByLabel("Hesap parolan").fill(PASSWORD);
  await target.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(target).toContainText("Uzak hedef doğrulandı ve kaydedildi.");
  await passphrase.getByLabel("Hesap parolan").fill(PASSWORD);
  await passphrase.getByRole("button", { name: "Parolayı kaldır" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Parolayı kaldır" }).click();
  await expect(passphrase).toContainText("Henüz parola belirlenmedi");
  await page.keyboard.press("Escape");
  await imported.getByRole("button", { name: "Sil", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sil" }).click();
  await expect(imported).toHaveCount(0);
  expect(
    (
      await page.request.post("/api/files/delete", {
        headers,
        data: { root: diskRootId(USB), paths: ["EveryOS Backups"], confirm: true },
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await page.request.post("/api/system/disks/unmount", {
        headers,
        data: { uuid: USB, confirm: USB },
      })
    ).status(),
  ).toBe(200);
});
