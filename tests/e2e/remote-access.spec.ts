import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";
import { CSRF_HEADER, type RemoteAccessOverview } from "../../packages/shared/src/index.ts";

test("remote access installs, configures and independently connects providers with explicit conflict consent", async ({
  page,
}) => {
  await signIn(page);
  let unreadable = false;
  await page.route("**/api/remote-access", async (route) => {
    const response = await route.fetch();
    const view = (await response.json()) as RemoteAccessOverview;
    const tailscale = view.providers.find((entry) => entry.node.provider === "tailscale")!;
    // Explicitly simulated telemetry: this fixture is an exit-node server, not an exit consumer.
    tailscale.node.advertisesExitNode = unreadable ? null : true;
    tailscale.node.defaultRoute = unreadable ? null : false;
    if (unreadable) {
      tailscale.node.available = false;
      tailscale.node.state = "unknown";
    }
    await route.fulfill({ response, json: view });
  });
  await page.getByTestId("dock").getByRole("button", { name: "Ayarlar", exact: true }).click();
  const settings = page.locator('[data-app-id="everyos.settings"]');
  await settings.getByRole("button", { name: "Uzaktan Erişim", exact: true }).click();
  const remote = page.getByTestId("remote-access"),
    ts = remote.getByTestId("remote-provider-tailscale"),
    nb = remote.getByTestId("remote-provider-netbird");
  await expect(remote).toContainText("Simüle veri");
  const advertisement = ts.locator("dl > div").filter({ hasText: "Exit node sunumu" });
  const exitUse = ts.locator("dl > div").filter({ hasText: "Exit node kullanımı" });
  await expect(advertisement).toContainText("Evet");
  await advertisement.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("exit-node-roles.png"),
    animations: "disabled",
  });
  await expect(exitUse).toContainText("Hayır");
  unreadable = true;
  await remote.getByRole("button", { name: "Durumu yenile", exact: true }).click();
  await expect(advertisement).toContainText("Bilinmiyor");
  await expect(exitUse).toContainText("Bilinmiyor");
  unreadable = false;
  await remote.getByRole("button", { name: "Durumu yenile", exact: true }).click();
  await expect(advertisement).toContainText("Evet");
  for (const provider of ["tailscale", "netbird"]) {
    const mark = remote
      .getByRole("tab", { name: new RegExp(provider, "i") })
      .getByTestId(`provider-logo-${provider}`);
    await expect
      .poll(() =>
        mark.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
  }
  await remote.getByRole("tab", { name: /Tailscale/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(remote.getByRole("tab", { name: /NetBird/ })).toBeFocused();
  await expect(remote.getByRole("tab", { name: /NetBird/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("ArrowLeft");
  await expect(remote.getByRole("tab", { name: /Tailscale/ })).toBeFocused();
  await expect(remote.getByRole("tab", { name: /Tailscale/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await remote.getByRole("tab", { name: /Tailscale/ }).click();
  await page.screenshot({
    path: test.info().outputPath("remote-access-overview.png"),
    animations: "disabled",
  });
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
  const configureExternally = async (managementUrl: string) => {
    const status = await page.evaluate(
      async ({ managementUrl, header }) => {
        const session = (await (await fetch("/api/auth/session")).json()) as { csrfToken: string };
        const response = await fetch("/api/remote-access/netbird/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json", [header]: session.csrfToken },
          body: JSON.stringify({
            confirm: true,
            managementUrl,
            acceptDNS: false,
            acceptRoutes: false,
          }),
        });
        return response.status;
      },
      { managementUrl, header: CSRF_HEADER },
    );
    expect(status).toBe(200);
    await remote.getByRole("button", { name: "Durumu yenile", exact: true }).click();
  };
  await configureExternally("https://external.example.test:8443");
  await expect(nb.getByLabel("Yönetim sunucusu", { exact: true })).toHaveValue(
    "https://external.example.test:8443",
  );
  await nb.getByRole("combobox", { name: "NetBird sunucusu" }).selectOption("selfHosted");
  await nb.getByLabel("Yönetim sunucusu", { exact: true }).fill("http://vpn.example.test");
  await expect(nb.getByRole("button", { name: "Ayarları kaydet", exact: true })).toBeDisabled();
  await nb.getByLabel("Yönetim sunucusu", { exact: true }).fill("https://vpn.example.test:8443");
  await configureExternally("https://second.example.test:8443");
  await expect(nb.getByLabel("Yönetim sunucusu", { exact: true })).toHaveValue(
    "https://vpn.example.test:8443",
  );
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
  await nb.getByRole("button", { name: "Yeniden bağlan", exact: true }).click();
  const reconnect = page.getByRole("dialog", { name: "NetBird bağlantısını yeniden başlat" });
  await expect(reconnect).toContainText("kısa süre kesilip yeniden kurulacak");
  await expect(
    reconnect.getByRole("button", { name: "Yeniden bağlan", exact: true }),
  ).toBeDisabled();
  await reconnect.getByRole("checkbox").check();
  await reconnect.getByRole("button", { name: "Yeniden bağlan", exact: true }).click();
  await expect(reconnect).toBeHidden();
  await expect(remote.getByRole("tab", { name: "Tailscale Bağlı", exact: true })).toBeVisible();
  await nb.getByRole("button", { name: "Cihazları göster", exact: true }).click();
  await expect(nb).toContainText("Simulated peer");
  await expect(nb).toContainText("100.64.0.20");
  await remote
    .getByRole("heading", { name: "Uzaktan Erişim", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("remote-access.png"),
    animations: "disabled",
  });

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
  await page.getByRole("button", { name: "Hızlı ayarlar", exact: true }).click();
  await page.getByRole("radio", { name: "Liquid Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "liquid-light");
  await page.getByRole("button", { name: "Hızlı ayarlar", exact: true }).click();
  await remote
    .getByRole("heading", { name: "Uzaktan Erişim", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("remote-access-light.png"),
    animations: "disabled",
  });
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
  await remote.getByRole("tab", { name: /NetBird/ }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("remote-access-mobile.png"),
    animations: "disabled",
  });
  await nb.getByRole("button", { name: "Bağlan", exact: true }).click();
  await expect(connect.getByRole("button", { name: "Bağlan", exact: true })).toBeInViewport();
  expect(await connect.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await connect.getByRole("button", { name: "Vazgeç", exact: true }).click();
  expect(
    await page.evaluate(async (header) => {
      const session = (await (await fetch("/api/auth/session")).json()) as { csrfToken: string };
      return (
        await fetch("/api/account", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", [header]: session.csrfToken },
          body: JSON.stringify({ locale: "en" }),
        })
      ).status;
    }, CSRF_HEADER),
  ).toBe(200);
  await page.reload();
  if (!(await remote.isVisible())) {
    await page
      .getByTestId("mobile-shell")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await page.getByRole("button", { name: "Remote Access", exact: true }).click();
  }
  await remote.getByRole("tab", { name: /Tailscale/ }).click();
  const englishAdvertisement = ts.locator("dl > div").filter({ hasText: "Offers an exit node" });
  await expect(englishAdvertisement).toContainText("Yes");
  await englishAdvertisement.scrollIntoViewIfNeeded();
  expect(await remote.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath("exit-node-mobile-en.png"),
    animations: "disabled",
  });
});
