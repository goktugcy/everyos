import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";
import type { TailscaleOverview } from "../../packages/shared/src/index.ts";
import { tailscaleDetailsUnavailable } from "../../packages/system/src/linux/tailscale.ts";

test("the Tailscale app explains this node, remote access and the tailnet's devices", async ({
  page,
}) => {
  await signIn(page);
  // The menu bar's network panel leads to the Tailscale app.
  await page.getByTestId("menubar-network").click();
  await page.getByRole("button", { name: "Tailscale ayrıntıları" }).click();
  const app = page.locator('[data-app-id="everyos.tailscale"]');
  await expect(app.getByTestId("tailscale-app")).toContainText("everyos-e2e");

  // Published with Serve, but the origin is not configured: the app says so.
  const remote = app.getByTestId("tailscale-remote");
  await expect(remote).toContainText("https://everyos-e2e.example-tailnet.ts.net");
  await expect(remote).toContainText("Yalnızca tailnet içinden");
  await expect(app.getByTestId("tailscale-warning").first()).toContainText(
    "server.publicOrigins listesinde değil",
  );
  await expect(app.getByTestId("tailscale-app")).toContainText("Ana DERP bölgesi");

  const peers = app.getByTestId("tailscale-peers");
  await expect(peers.getByRole("row", { name: /laptop/ })).toContainText("Doğrudan");
  await expect(peers.getByRole("row", { name: /phone/ })).toContainText("Aktarmalı (DERP: ams)");
  let failRefresh = false;
  await page.route("**/api/system/tailscale/overview", async (route) => {
    if (failRefresh) {
      await route.fulfill({
        status: 503,
        json: { error: { code: "AGENT_UNAVAILABLE", message: "Fixture agent unavailable" } },
      });
      return;
    }
    const response = await route.fetch();
    const overview = (await response.json()) as TailscaleOverview;
    overview.details = tailscaleDetailsUnavailable("permission-denied");
    await route.fulfill({ response, json: overview });
  });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(
    app.getByText("Çıkış düğümü olarak kullanılabilir", { exact: true }).locator(".."),
  ).toContainText("Bilinmiyor");
  await expect(app.getByText("Anahtar süresi", { exact: true }).locator("..")).toContainText(
    "Bilinmiyor",
  );
  const existingAlerts = await app.getByRole("alert").count();
  failRefresh = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(app.getByRole("alert")).toHaveCount(existingAlerts + 1);
  await expect(app.getByTestId("tailscale-app")).toBeVisible();
});
