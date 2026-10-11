import { expect, test, type Page } from "@playwright/test";
import { preferences, signIn } from "./helpers.ts";

const port = Number(process.env.EVERYOS_E2E_PORT ?? 7480);

async function openWidgetSettings(page: Page) {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("widget");
  await page.getByRole("option", { name: "Ayarlar: Widget'lar" }).click();
  const settings = page.locator('[data-app-id="everyos.settings"]');
  await expect(settings.getByTestId("settings-widgets")).toBeVisible();
  return settings;
}

function desktopWidget(page: Page, widgetId: string) {
  return page
    .getByTestId("desktop-widget")
    .filter({ has: page.locator(`[data-widget="${widgetId}"]`) });
}

test("widgets are placed on the desktop, sidebar and menu bar, configured and persisted", async ({
  page,
}) => {
  await signIn(page);
  await page
    .getByTestId("desktop-surface")
    .click({ button: "right", position: { x: 550, y: 250 } });
  await page.getByRole("menuitem", { name: "Widget ekle…", exact: true }).click();
  const gallery = page.getByRole("dialog", { name: "Widget galerisi" });
  await expect(gallery).toBeVisible();

  const cpuCard = gallery.locator('[data-widget="system.cpu"]');
  await cpuCard.getByRole("radio", { name: "Orta", exact: true }).click();
  await cpuCard.getByRole("button", { name: "Ekle: İşlemci" }).click();
  await gallery.getByRole("tab", { name: "Docker", exact: true }).click();
  await gallery.getByRole("button", { name: "Ekle: Docker özeti" }).click();
  await gallery.getByRole("tab", { name: "Tümü", exact: true }).click();
  await gallery.getByRole("radio", { name: "Menü çubuğu", exact: true }).click();
  // Widgets without a compact form are not offered for the menu bar.
  await expect(gallery.locator('[data-widget="system.processes"]')).toContainText(
    "Bu konumda kullanılamaz",
  );
  await gallery.getByRole("button", { name: "Ekle: Bellek" }).click();
  await page.keyboard.press("Escape");
  await expect(gallery).toBeHidden();

  const cpu = desktopWidget(page, "system.cpu");
  await expect(cpu).toContainText(/%\s?\d/);
  const docker = desktopWidget(page, "docker.summary");
  await expect(docker).toContainText("Çalışan konteynerler");
  // The e2e stack uses the Docker simulator; the widget must say so.
  await expect(docker).toContainText("Simüle veri");
  await expect(page.getByTestId("menubar").locator('[data-widget="system.memory"]')).toContainText(
    /Bellek\s*%\s?\d/,
  );

  // The default sidebar carries four system widgets; windows make room for it.
  await page.getByTestId("widget-sidebar-toggle").click();
  const sidebar = page.getByTestId("widget-sidebar");
  await expect(sidebar.getByTestId("widget")).toHaveCount(4);
  await expect(page.getByTestId("widget-sidebar-toggle")).toHaveAttribute("aria-pressed", "true");

  await cpu.getByTestId("widget-menu").click();
  await page.getByRole("menuitem", { name: "Yapılandır…", exact: true }).click();
  const configure = page.getByRole("dialog", { name: "İşlemci ayarları" });
  await configure.getByRole("switch", { name: "Trend grafiğini göster" }).click();
  await configure.getByRole("button", { name: "Kaydet", exact: true }).click();
  const desktopCpu = async () =>
    (await preferences(page)).widgets?.instances.find(
      (i) => i.widgetId === "system.cpu" && i.placement === "desktop",
    );
  await expect.poll(async () => (await desktopCpu())?.config.chart).toBe(false);

  // Drag by the header: the widget snaps to the 80 px grid.
  const before = (await cpu.boundingBox())!;
  await page.mouse.move(before.x + 40, before.y + 14);
  await page.mouse.down();
  await page.mouse.move(before.x - 120, before.y + 94, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await cpu.boundingBox())!.x).toBeLessThan(before.x - 100);
  const moved = (await cpu.boundingBox())!;
  expect(Math.round(before.x - moved.x) % 80).toBe(0);

  // Resizing makes a custom size in whole cells; growing into a neighbour is refused.
  const resize = async (dx: number, dy: number) => {
    const handle = (await cpu.getByTestId("widget-resize").boundingBox())!;
    await page.mouse.move(handle.x + 8, handle.y + 8);
    await page.mouse.down();
    await page.mouse.move(handle.x + 8 + dx, handle.y + 8 + dy, { steps: 6 });
    await page.mouse.up();
  };
  await resize(90, 0);
  await expect(page.getByRole("status").filter({ hasText: "yeterli boş alan yok" })).toBeVisible();
  expect((await desktopCpu())?.custom).toBeNull();
  await resize(0, 90);
  await expect.poll(async () => (await desktopCpu())?.custom).toEqual({ w: 4, h: 3 });

  await page.screenshot({
    path: test.info().outputPath("widgets-desktop.png"),
    animations: "disabled",
  });

  await page.reload();
  await expect(cpu).toBeVisible();
  await expect(docker).toBeVisible();
  await expect(sidebar).toBeVisible();
  await expect(page.getByTestId("menubar").locator('[data-widget="system.memory"]')).toBeVisible();

  // A container widget asks for its target first.
  await page
    .getByTestId("desktop-surface")
    .click({ button: "right", position: { x: 300, y: 500 } });
  await page.getByRole("menuitem", { name: "Widget ekle…", exact: true }).click();
  await page.getByRole("button", { name: "Ekle: Konteyner / uygulama" }).click();
  const target = page.getByRole("dialog", { name: "Konteyner / uygulama ayarları" });
  await target.getByLabel("Konteyner, proje veya uygulama").selectOption({ index: 1 });
  await target.getByRole("button", { name: "Kaydet", exact: true }).click();
  const container = desktopWidget(page, "docker.app");
  await expect(container).toContainText("Bellek");
  await expect(container).not.toContainText("Kurulum gerekli");

  const settings = await openWidgetSettings(page);
  await settings.getByRole("button", { name: "Varsayılan widget düzenine dön" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sıfırla", exact: true }).click();
  await expect(page.getByTestId("desktop-widget")).toHaveCount(0);
  await expect(page.getByTestId("menubar").locator('[data-testid="menubar-widget"]')).toHaveCount(
    0,
  );
  await expect(sidebar.getByTestId("widget")).toHaveCount(4);
});

test("app connections feed widgets without exposing credentials or private details", async ({
  page,
}) => {
  await signIn(page);
  const settings = await openWidgetSettings(page);
  await settings.getByRole("button", { name: "Bağlantı ekle", exact: true }).click();
  let form = page.getByRole("dialog", { name: "Bağlantı ekle" });
  await expect(form.getByLabel("Uygulama türü")).toHaveValue("jellyfin");
  await form.getByLabel("Ad", { exact: true }).fill("Ev sineması");
  await form.getByLabel("Adres", { exact: true }).fill(`http://127.0.0.1:${port + 1}/jellyfin`);
  await form.getByLabel("API anahtarı", { exact: true }).fill("e2e-jellyfin-key");
  await form.getByRole("button", { name: "Kaydet", exact: true }).click();
  const item = settings.getByTestId("integration-item").filter({ hasText: "Ev sineması" });
  await expect(item).toContainText("Kimlik bilgisi kayıtlı");
  await expect(item).toContainText("Yalnızca uygulama yöneticileri");
  await item.getByRole("button", { name: "Test et", exact: true }).click();
  await expect(item).toContainText("Bağlantı çalışıyor.");
  expect(await (await page.request.get("/api/integrations")).text()).not.toContain(
    "e2e-jellyfin-key",
  );

  await settings.getByRole("button", { name: "Widget galerisini aç" }).click();
  const gallery = page.getByRole("dialog", { name: "Widget galerisi" });
  await gallery.getByRole("tab", { name: "Uygulamalar", exact: true }).click();
  // Apps without a connection explain what is missing instead of adding an empty widget.
  await expect(gallery.locator('[data-widget="immich.status"]')).toContainText(
    "Önce bir Immich bağlantısı gerekli.",
  );
  await gallery.getByRole("button", { name: "Ekle: Jellyfin oynatmaları" }).click();
  await page.keyboard.press("Escape");
  const sessions = desktopWidget(page, "jellyfin.sessions");
  await expect(sessions).toContainText("Deneme Filmi");
  await expect(sessions).toContainText("ayse");
  await expect(sessions).toContainText("Etkin oturum: 2");
  // Client addresses reported by the app never reach the browser.
  await expect(sessions).not.toContainText("192.168.1.44");

  // A rejected credential and an unreachable app are explained, not hidden.
  await item.getByRole("button", { name: "Bağlantıyı düzenle" }).click();
  form = page.getByRole("dialog", { name: "Bağlantıyı düzenle" });
  await form.getByLabel("API anahtarı", { exact: true }).fill("wrong-key");
  await form.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(sessions).toContainText("Uygulama kimlik bilgisini reddetti");
  await item.getByRole("button", { name: "Bağlantıyı düzenle" }).click();
  form = page.getByRole("dialog", { name: "Bağlantıyı düzenle" });
  await form.getByLabel("Adres", { exact: true }).fill(`http://127.0.0.1:${port + 9}/jellyfin`);
  await form.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(sessions).toContainText("Uygulamaya ulaşılamıyor");

  await item.getByRole("button", { name: "Sil", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Bağlantıyı sil" }).click();
  await expect(item).toHaveCount(0);
  await expect(sessions).toContainText("Uygulama bağlantısı bulunamadı.");
});
