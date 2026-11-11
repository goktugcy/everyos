import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

test("remote access installs, configures and independently connects providers with explicit conflict consent", async ({
  page,
}) => {
  await signIn(page);
  await page.getByTestId("dock").getByRole("button", { name: "Ayarlar", exact: true }).click();
  const settings = page.locator('[data-app-id="everyos.settings"]');
  await settings.getByRole("button", { name: "Uzaktan Erişim", exact: true }).click();
  const remote = page.getByTestId("remote-access"),
    ts = remote.getByTestId("remote-provider-tailscale"),
    nb = remote.getByTestId("remote-provider-netbird");
  await expect(remote).toContainText("Simüle veri");
  await ts.getByLabel("Sağlayıcının DNS ayarlarını kullan").check();
  await ts.getByLabel("Sağlayıcının ağ rotalarını kabul et").check();
  await ts.getByRole("button", { name: "Ayarları kaydet", exact: true }).click();
  await expect(ts.getByRole("button", { name: "Bağlan", exact: true })).toBeEnabled();
  await ts.getByRole("button", { name: "Bağlan", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Tailscale bağlantısını başlat" })
    .getByRole("button", { name: "Bağlan", exact: true })
    .click();
  await expect(remote.getByRole("tab", { name: "Tailscale Bağlı", exact: true })).toBeVisible();
  await remote.getByRole("tab", { name: /NetBird/ }).click();
  await nb.getByRole("button", { name: "Kur", exact: true }).click();
  const install = page.getByRole("dialog", { name: "NetBird kurulumunu başlat" });
  await expect(install).toContainText("pkgs.netbird.io");
  await install.getByRole("button", { name: "Kur", exact: true }).click();
  await expect(
    nb.getByText("Kurulum tamamlandı. Kayıt anahtarıyla bağlanabilirsiniz.", { exact: true }),
  ).toBeVisible();
  await nb.getByRole("combobox", { name: "NetBird sunucusu" }).selectOption("selfHosted");
  await nb.getByLabel("Yönetim sunucusu", { exact: true }).fill("http://vpn.example.test");
  await expect(nb.getByRole("button", { name: "Ayarları kaydet", exact: true })).toBeDisabled();
  await nb.getByLabel("Yönetim sunucusu", { exact: true }).fill("https://vpn.example.test:8443");
  await nb.getByLabel("Sağlayıcının DNS ayarlarını kullan").check();
  await nb.getByLabel("Sağlayıcının ağ rotalarını kabul et").check();
  await nb.getByRole("button", { name: "Ayarları kaydet", exact: true }).click();
  await expect(nb.getByRole("button", { name: "Bağlan", exact: true })).toBeEnabled();
  await nb.getByLabel("Kayıt anahtarı", { exact: true }).fill("fixture-only-setup-key");
  await nb.getByRole("button", { name: "Bağlan", exact: true }).click();
  const connect = page.getByRole("dialog", { name: "NetBird bağlantısını başlat" });
  await expect(connect).toContainText("https://vpn.example.test:8443");
  await expect(connect.getByRole("button", { name: "Bağlan", exact: true })).toBeDisabled();
  await connect.getByRole("checkbox").check();
  await connect.getByRole("button", { name: "Bağlan", exact: true }).click();
  await expect(remote.getByRole("tab", { name: "NetBird Bağlı", exact: true })).toBeVisible();
  await expect(nb.getByLabel("Kayıt anahtarı", { exact: true })).toHaveValue("");
  await expect(remote).toContainText("İki sağlayıcı da DNS yönetiyor");
  await expect(remote).toContainText("VPN ağ rotaları kesişiyor");
  await nb.getByRole("button", { name: "Cihazları göster", exact: true }).click();
  await expect(nb).toContainText("Simulated peer");
  await expect(nb).toContainText("100.64.0.20");
  await page.screenshot({ path: test.info().outputPath("remote-access.png") });

  await page.reload();
  await expect(nb.getByLabel("Yönetim sunucusu", { exact: true })).toHaveValue(
    "https://vpn.example.test:8443",
  );
  await nb.getByRole("button", { name: "Bağlantıyı kes", exact: true }).click();
  await page
    .getByRole("dialog", { name: "NetBird bağlantısını kes" })
    .getByRole("button", { name: "Bağlantıyı kes", exact: true })
    .click();
  await expect(remote.getByRole("tab", { name: "NetBird Bağlı değil", exact: true })).toBeVisible();
  await expect(remote.getByRole("tab", { name: "Tailscale Bağlı", exact: true })).toBeVisible();
  await expect(remote).not.toContainText("İki sağlayıcı da DNS yönetiyor");
  await page.setViewportSize({ width: 375, height: 812 });
  // The mobile shell opens on its home screen; reopen Settings after the transition.
  await page
    .getByTestId("mobile-shell")
    .getByRole("button", { name: "Ayarlar", exact: true })
    .click();
  await page.getByRole("button", { name: "Uzaktan Erişim", exact: true }).click();
  await remote.getByRole("tab", { name: /NetBird/ }).click();
  await expect(nb).toBeVisible();
  expect(await remote.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await nb.getByRole("button", { name: "Bağlan", exact: true }).click();
  await expect(connect.getByRole("button", { name: "Bağlan", exact: true })).toBeInViewport();
  expect(await connect.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await connect.getByRole("button", { name: "Vazgeç", exact: true }).click();
});
