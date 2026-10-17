import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { signIn, stateDir } from "./helpers.ts";

/** The development agent's simulator treats this file as a plugged-in USB stick. */
const STICK = join(stateDir, "disks", ".simulated-usb-stick");

test.afterEach(() => {
  rmSync(STICK, { force: true });
});

test("a plugged-in disk appears on the desktop, mounts with one click and shows in Files", async ({
  page,
}) => {
  await signIn(page);
  writeFileSync(STICK, "");
  const icon = page.locator('[data-testid="desktop-volume"][data-volume="5E6F-7A8B"]');
  await expect(icon).toHaveAttribute("data-mounted", "false");
  await expect(icon).toContainText("KINGSTON");
  // The pulse names it for a moment, and a notification says so too.
  const message = page.getByTestId("pulse-message");
  await expect(message).toHaveAttribute("data-kind", "attached");
  await expect(message).toContainText("Yeni disk bağlandı");
  await expect(message).toContainText("KINGSTON");
  await page.getByTestId("pulse-trigger").screenshot({
    path: test.info().outputPath("pulse-attached.png"),
    animations: "disabled",
  });
  const kinds = async () =>
    (
      (await (await page.request.get("/api/notifications?limit=50")).json()) as {
        notifications: Array<{ kind: string; params: Record<string, string> }>;
      }
    ).notifications.filter((notice) => notice.kind.startsWith("disk-"));
  await expect
    .poll(async () => (await kinds()).map((notice) => notice.kind))
    .toContain("disk-attached");
  await icon.getByRole("button").dblclick();
  const dialog = page.getByTestId("disk-mount-dialog");
  await expect(dialog).toContainText("KINGSTON");
  await expect(dialog.getByRole("checkbox")).toBeChecked();
  await page.screenshot({
    path: test.info().outputPath("mount-dialog.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Bağla", exact: true }).click();
  // Mounting opens the disk in Files; the desktop icon lights up.
  await expect(icon).toHaveAttribute("data-mounted", "true");
  const files = page.locator('[data-app-id="everyos.files"]');
  await expect(files.getByTestId("files-sidebar")).toContainText("KINGSTON");
  await page.screenshot({
    path: test.info().outputPath("disk-desktop.png"),
    animations: "disabled",
  });
  await files.getByRole("button", { name: "Kapat", exact: true }).first().click();

  // The menu bar's storage panel lists it with an eject button.
  await page.getByTestId("menubar-storage").click();
  const panel = page.getByTestId("storage-panel");
  await expect(
    panel.locator('[data-testid="storage-volume"][data-volume="5E6F-7A8B"]'),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("storage-panel.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");

  // Pulled out while mounted: gone from the desktop, remembered in Settings.
  rmSync(STICK);
  await expect(icon).toHaveCount(0);
  await expect(message).toHaveAttribute("data-kind", "detached");
  await expect(message).toContainText("Disk çıkarıldı");
  await expect
    .poll(
      async () => (await kinds()).find((notice) => notice.kind === "disk-detached")?.params.unsafe,
    )
    .toBe("yes");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("ayarlar");
  await page.keyboard.press("Enter");
  const settings = page.locator('[data-app-id="everyos.settings"]');
  await settings.getByRole("button", { name: "Diskler", exact: true }).click();
  const remembered = settings.getByTestId("remembered-disks");
  await expect(remembered).toContainText("KINGSTON");
  // Plugged in again: mounted by itself.
  writeFileSync(STICK, "");
  await expect(icon).toHaveAttribute("data-mounted", "true");
  await icon.getByRole("button").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Güvenle çıkar" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Güvenle çıkar", exact: true })
    .click();
  await expect(icon).toHaveAttribute("data-mounted", "false");
  rmSync(STICK);
  await expect(remembered).toHaveCount(0);
});

test("uploads report their speed, and Google Drive connects, browses and copies into EveryOS", async ({
  page,
  context,
}) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("ayarlar");
  await page.keyboard.press("Enter");
  const settings = page.locator('[data-app-id="everyos.settings"]');
  await settings.getByRole("button", { name: "Bağlantılar", exact: true }).click();
  const client = settings.getByTestId("drive-client");
  await client.getByLabel("İstemci kimliği (Client ID)").fill("123-e2e.apps.googleusercontent.com");
  await client.getByLabel("İstemci sırrı (Client secret)").fill("GOCSPX-e2e-secret");
  await client.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(client).toContainText("Google istemcisi kaydedildi.");
  expect(await (await page.request.get("/api/drive/client")).text()).not.toContain("GOCSPX");

  // Google's consent comes back to EveryOS in the new tab and finishes there.
  const account = settings.getByTestId("drive-account");
  const [consent] = await Promise.all([
    context.waitForEvent("page"),
    account.getByTestId("drive-connect").click(),
  ]);
  await expect(
    consent.locator('[data-app-id="everyos.settings"]').getByTestId("drive-account"),
  ).toContainText("owner@example.com olarak bağlı");
  await consent.close();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(account).toContainText("owner@example.com olarak bağlı");
  await page.screenshot({
    path: test.info().outputPath("connections.png"),
    animations: "disabled",
  });

  // Drive inside Files: a folder, a file from this computer, then a copy into EveryOS.
  await account.getByRole("button", { name: "Dosyalar'da aç" }).click();
  const files = page.locator('[data-app-id="everyos.files"]').last();
  const drive = files.getByTestId("drive-browser");
  await expect(drive).toContainText("Drive'ım");
  await drive.getByRole("button", { name: "Yeni klasör" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(drive.locator('[data-testid="drive-row"][data-name="Yeni klasör"]')).toBeVisible();
  await drive.locator("input[type=file]").setInputFiles({
    name: "rapor.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Drive'a giden rapor"),
  });
  const report = drive.locator('[data-testid="drive-row"][data-name="rapor.txt"]');
  await expect(report).toBeVisible();
  await report.click({ button: "right" });
  await page.getByRole("menuitem", { name: "EveryOS'a kopyala…" }).click();
  const picker = page.getByTestId("folder-picker");
  await picker.getByRole("button", { name: "goktug" }).first().click();
  await picker.getByRole("button", { name: "Buraya kopyala" }).click();
  await expect(drive.getByTestId("drive-notice")).toContainText("rapor.txt");

  // The menu bar lists the finished transfers: the browser upload and the server copy.
  await page.getByTestId("menubar-storage").click();
  const panel = page.getByTestId("storage-panel");
  await expect(panel.locator('[data-testid="transfer"][data-state="done"]')).toHaveCount(2);
  await expect(panel.getByTestId("storage-drive")).toContainText("owner@example.com");
  await page.screenshot({ path: test.info().outputPath("transfers.png"), animations: "disabled" });
  await panel.getByRole("button", { name: "Bitenleri temizle" }).click();
  await expect(panel.getByTestId("transfer")).toHaveCount(0);
  await page.keyboard.press("Escape");
  const copied = await page.request.get("/api/files/text?root=home&path=rapor.txt");
  expect((await copied.json()) as { content: string }).toMatchObject({
    content: "Drive'a giden rapor",
  });
  expect(existsSync(STICK)).toBe(false);
});

test("a slow upload shows its speed and time left in the menu bar, the dock and Files", async ({
  page,
  context,
}) => {
  await signIn(page);
  // About 300 KB/s up, so a 2.5 MB upload takes several seconds.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 20,
    downloadThroughput: -1,
    uploadThroughput: 300 * 1024,
  });
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("dosyalar");
  await page.keyboard.press("Enter");
  const files = page.locator('[data-app-id="everyos.files"]');
  await files
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "video.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(2_500_000, 1),
    });
  const indicator = page.getByTestId("menubar-storage");
  await expect(indicator).toHaveAttribute("data-active", "true");
  // With the pulse showing the progress, the menu bar item keeps only its ring and tooltip.
  await expect(indicator).toHaveAttribute("title", /\d+([.,]\d)? (KB|MB)\/sn/);
  await expect(page.getByTestId("dock-storage")).toHaveAttribute("data-active", "true");
  await expect(files.getByTestId("upload-speed")).toContainText(/(KB|MB)\/sn · ~\d+ sn/);
  // The pulse turns into a progress bar with the speed in its tooltip, and lists the upload.
  const pulse = page.getByTestId("pulse-trigger");
  await expect(pulse).toHaveAttribute("data-mode", "transfer");
  // Above the two-row progress bar: how much has moved, and how fast.
  await expect(page.getByTestId("pulse-amount")).toContainText(
    /\d+([.,]\d)? (KB|MB)\s*\/ 2[.,]5 MB/,
  );
  await pulse.screenshot({
    path: test.info().outputPath("pulse-amount.png"),
    animations: "disabled",
  });
  await pulse.screenshot({
    path: test.info().outputPath("pulse-dots.png"),
    animations: "disabled",
  });
  await expect(pulse).toHaveAttribute("title", /video\.bin · \d+([.,]\d)? (KB|MB)\/sn/);
  await pulse.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Aktarımlar" }).click();
  await expect(page.getByTestId("pulse-transfers")).toContainText("video.bin");
  await page.screenshot({
    path: test.info().outputPath("pulse-running.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await indicator.click();
  const running = page
    .getByTestId("storage-panel")
    .locator('[data-testid="transfer"][data-state="running"]');
  await expect(running).toContainText("video.bin");
  await expect(running.getByTestId("transfer-status")).toContainText(/kaldı/);
  await page.screenshot({
    path: test.info().outputPath("upload-running.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(indicator).toHaveAttribute("data-active", "false", { timeout: 30_000 });
  // Finished: the dots return to the heartbeat.
  await expect(pulse).not.toHaveAttribute("data-mode", "transfer");
  await expect(page.getByTestId("pulse-amount")).toHaveCount(0);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
});

test("dropping files from the computer on a Files window never leaves the pulse in drop mode", async ({
  page,
}) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("dosyalar");
  await page.keyboard.press("Enter");
  const list = page.locator('[data-app-id="everyos.files"] [data-testid="file-list"]');
  await expect(list).toBeVisible();
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["drop test"], "dropped.txt", { type: "text/plain" }));
    return data;
  });
  const pulse = page.getByTestId("pulse-trigger");
  await list.dispatchEvent("dragenter", { dataTransfer: transfer });
  await list.dispatchEvent("dragover", { dataTransfer: transfer });
  await expect(pulse).toHaveAttribute("data-mode", "drop");
  // Files takes the drop (and stops it there); the pulse still notices.
  await list.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(pulse).not.toHaveAttribute("data-mode", "drop");
  await expect(
    page.locator('[data-app-id="everyos.files"] [data-testid="file-row"][data-name="dropped.txt"]'),
  ).toBeVisible();
  // A drag that just stops (Esc, leaving the window) ends by itself too.
  await list.dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(pulse).toHaveAttribute("data-mode", "drop");
  await expect(pulse).not.toHaveAttribute("data-mode", "drop", { timeout: 2_000 });
});
