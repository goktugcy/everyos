import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { PASSWORD, signIn } from "./helpers.ts";

test("power actions ask for the password and the simulator never powers off the host", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "EveryOS menüsü", exact: true }).click();
  await page.getByRole("menuitem", { name: "Yeniden başlat…", exact: true }).click();
  const dialog = page.getByTestId("power-dialog");
  await expect(page.getByRole("dialog", { name: "Sunucuyu yeniden başlat" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Yeniden başlat", exact: true })).toBeDisabled();
  await dialog.getByLabel("Parolanız", { exact: true }).fill("wrong-password-value");
  await dialog.getByRole("button", { name: "Yeniden başlat", exact: true }).click();
  await expect(dialog).toContainText("Mevcut parola hatalı");
  await dialog.getByLabel("Parolanız", { exact: true }).fill(PASSWORD);
  await dialog.getByRole("button", { name: "Yeniden başlat", exact: true }).click();
  const screen = page.getByTestId("power-screen");
  await expect(screen).toContainText("Sunucu yeniden başlatılıyor");
  await expect(screen).toContainText("simüle edildi");
  await screen.getByRole("button", { name: "Kapat", exact: true }).click();
  await expect(screen).toHaveCount(0);
});

test("disks mount from Settings, appear in Files and eject after confirmation", async ({
  page,
}) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("ayarlar");
  await page.keyboard.press("Enter");
  const settings = page.locator('[data-app-id="everyos.settings"]');
  await settings.getByRole("button", { name: "Diskler", exact: true }).click();
  const disks = settings.getByTestId("disks");
  await expect(disks.locator('[data-disk="sda"]')).toContainText("Simulated USB Disk");
  // The system card is listed for information only, without any action.
  await disks.getByText("Sistem diskleri", { exact: true }).click();
  await expect(disks.locator('[data-disk="mmcblk0"]')).toContainText("Sistem diski");
  await expect(disks.locator('[data-disk="mmcblk0"]').getByRole("button")).toHaveCount(0);
  const volume = disks.locator('[data-volume="sda1"]');
  await volume.getByRole("button", { name: "Bağla", exact: true }).click();
  await expect(volume).toContainText("Bağlı · açılışta yeniden bağlanır");
  await page.screenshot({ path: test.info().outputPath("disks.png"), animations: "disabled" });
  await volume.getByRole("button", { name: "Dosyalar'da aç", exact: true }).click();
  const files = page.locator('[data-app-id="everyos.files"]');
  await expect(files.getByTestId("files-sidebar")).toContainText("Diskler");
  await expect(files.getByTestId("files-sidebar")).toContainText("Yedek");
  await files.getByRole("button", { name: "Kapat", exact: true }).first().click();
  await volume.getByRole("button", { name: "Güvenle çıkar", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Güvenle çıkar", exact: true })
    .click();
  await expect(volume).toContainText("Bağlı değil");
});

test("an external webhook channel receives a test message and never shows its address", async ({
  page,
}) => {
  const received: Array<Record<string, unknown>> = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part as Buffer);
    received.push(JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>);
    response.writeHead(204);
    response.end();
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await signIn(page);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("ayarlar");
    await page.keyboard.press("Enter");
    const settings = page.locator('[data-app-id="everyos.settings"]');
    await settings.getByRole("button", { name: "Bildirimler", exact: true }).click();
    const channels = settings.getByTestId("notification-channels");
    await channels.getByRole("button", { name: "Kanal ekle" }).click();
    const form = page.getByTestId("notification-channel-form");
    await form.getByRole("radio", { name: /Webhook/ }).click();
    await form.getByLabel("Ad", { exact: true }).fill("E2E webhook");
    await form.getByLabel("Biçim", { exact: true }).selectOption("json");
    await form
      .getByLabel("Webhook adresi", { exact: true })
      .fill(`http://127.0.0.1:${port}/hooks/private-key`);
    await form.getByRole("button", { name: "Kaydet", exact: true }).click();
    const channel = channels.getByTestId("notification-channel");
    await expect(channel).toContainText("E2E webhook");
    expect(await (await page.request.get("/api/notification-channels")).text()).not.toContain(
      "private-key",
    );
    await channel.getByRole("button", { name: "Deneme mesajı gönder" }).click();
    await expect(channels).toContainText("Deneme mesajı gönderildi.");
    expect(received[0]).toMatchObject({ source: "everyos", title: "EveryOS deneme mesajı" });
    await channel.getByRole("button", { name: /Kanalı sil/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Sil", exact: true }).click();
    await expect(channel).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("phones get the notification center and the power actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const shell = page.getByTestId("mobile-shell");
  await expect(shell).toBeVisible();
  await shell.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-center")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shell.getByRole("button", { name: "Yeniden başlat…" })).toBeVisible();
  await expect(shell.getByRole("button", { name: "Kapat…" })).toBeVisible();
});
