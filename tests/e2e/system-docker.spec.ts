import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, signIn } from "./helpers.ts";

/*
 * Phase 4 Docker management against the development Docker simulator
 * (EVERYOS_AGENT_SIMULATE=1 in the e2e stack), so it runs the same on macOS
 * and CI and never touches a real Docker host.
 */

test.describe.configure({ mode: "serial" });

async function openDocker(page: Page) {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("docker");
  await page.keyboard.press("Enter");
  const app = page.locator('[data-app-id="everyos.docker"]');
  await expect(app).toBeVisible();
  return app;
}

test("containers are grouped by project with security warnings, logs and live stats", async ({
  page,
}) => {
  await signIn(page);
  const app = await openDocker(page);
  const list = app.getByTestId("container-list");
  await expect(list.getByRole("region", { name: "media" })).toBeVisible();
  await expect(list.getByRole("region", { name: "Bağımsız konteynerler" })).toBeVisible();
  await expect(app.getByTestId("simulated-badge").first()).toBeVisible();

  await list.getByRole("button", { name: /^homeassistant/ }).click();
  const detail = app.getByTestId("container-detail");
  await expect(detail.getByTestId("container-risks")).toContainText("Ayrıcalıklı mod");
  await expect(detail.getByTestId("container-risks")).toContainText("Host ağını kullanıyor");

  await list.getByRole("button", { name: /^nextcloud-db/ }).click();
  await expect(detail.getByText("POSTGRES_PASSWORD", { exact: true })).toBeVisible();
  await expect(
    detail.getByText(/Değerler gizli bilgi içerebileceği için gösterilmez/),
  ).toBeVisible();

  await detail.getByRole("tab", { name: "Günlükler", exact: true }).click();
  await expect(detail.getByTestId("docker-logs").locator("li").first()).toBeVisible();

  await detail.getByRole("tab", { name: "Kaynak kullanımı", exact: true }).click();
  // Stats are sampled every 5 s; a line needs two samples.
  await expect
    .poll(() => detail.locator('[role="group"] svg path[fill="none"][d*="L"]').count(), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  await page.screenshot({
    path: test.info().outputPath("docker-containers.png"),
    animations: "disabled",
  });
});

test("external containers can be stopped and started after confirmation", async ({ page }) => {
  await signIn(page);
  const app = await openDocker(page);
  await app
    .getByTestId("container-list")
    .getByRole("button", { name: /^qbittorrent/ })
    .click();
  const detail = app.getByTestId("container-detail");
  await expect(detail.getByText("Harici", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Durdur", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Durdur", exact: true }).click();
  await expect(detail.getByText("Durdu", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Başlat", exact: true }).click();
  await expect(detail.getByText("Çalışıyor", { exact: true })).toBeVisible();
});

test("log stream failures show an error and can be retried", async ({ page }) => {
  await signIn(page);
  const app = await openDocker(page);
  await app
    .getByTestId("container-list")
    .getByRole("button", { name: /^jellyfin/ })
    .click();
  const detail = app.getByTestId("container-detail");
  await page.route(
    "**/api/docker/containers/*/logs?*",
    async (route) => {
      await route.fulfill({
        contentType: "text/event-stream",
        body: 'event: ready\ndata: {}\n\nevent: error\ndata: {"code":"HOST_CAPABILITY_UNAVAILABLE"}\n\n',
      });
    },
    { times: 1 },
  );
  await detail.getByRole("tab", { name: "Günlükler", exact: true }).click();
  await expect(detail.getByRole("alert")).toBeVisible();
  await detail.getByRole("button", { name: "Tekrar dene", exact: true }).click();
  await expect(detail.getByTestId("docker-logs").locator("li").first()).toBeVisible();
  await expect(detail.getByRole("alert")).toHaveCount(0);
});

test("Compose projects are managed only after an explicit import", async ({ page }) => {
  await signIn(page);
  const app = await openDocker(page);
  await app.getByRole("tab", { name: "Compose projeleri", exact: true }).click();
  const media = app.getByTestId("project-media");
  await expect(media.getByText("Harici", { exact: true })).toBeVisible();
  await expect(media.getByRole("button", { name: "Kaldır (down)" })).toHaveCount(0);

  await media.getByRole("button", { name: "İçe aktar", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "İçe aktar", exact: true }).click();
  await expect(media.getByText("İçe aktarıldı", { exact: true })).toBeVisible();

  await media.getByRole("button", { name: "Kaldır (down)", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Kaldır (down)", exact: true })
    .click();
  await expect(media.getByText("0/0 çalışıyor")).toBeVisible();
  await media.getByRole("button", { name: "Başlat (up)", exact: true }).click();
  await expect(media.getByText("2/2 çalışıyor")).toBeVisible();

  // A project another tool manages needs an explicit acknowledgement.
  const pihole = app.getByTestId("project-big-bear-pihole");
  await expect(pihole.getByText(/CasaOS tarafından yönetiliyor/)).toBeVisible();
  await pihole.getByRole("button", { name: "İçe aktar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "İçe aktar", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Kapat" }).click();
  await page.screenshot({
    path: test.info().outputPath("docker-projects.png"),
    animations: "disabled",
  });

  const audit = (await (await page.request.get("/api/audit?limit=50")).json()) as {
    events: Array<{ action: string; target: string; outcome: string }>;
  };
  expect(audit.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "docker.projects.import",
        target: "media",
        outcome: "success",
      }),
      expect.objectContaining({
        action: "docker.projects.down",
        target: "media",
        outcome: "success",
      }),
    ]),
  );
});

test("volumes are deleted only after typing their name", async ({ page }) => {
  await signIn(page);
  const app = await openDocker(page);
  await app.getByRole("tab", { name: "Volume'lar", exact: true }).click();
  const table = app.getByTestId("volume-table");
  // Volumes in use offer no delete action.
  await expect(table.getByRole("button", { name: "Sil cloud_db" })).toHaveCount(0);
  await table.getByRole("button", { name: "Sil orphan_volume" }).click();
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "Kalıcı olarak sil" });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("textbox").fill("orphan_volume");
  await confirm.click();
  await expect(table.getByText("orphan_volume")).toHaveCount(0);
});

test("a mobile viewer can inspect Docker without management or log access", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel(/Kullanıcı adı|Username/).fill("izleyici");
  await page.getByLabel(/^(Parola|Password)$/).fill(PASSWORD);
  await page.getByRole("button", { name: /Giriş yap|Sign in/ }).click();
  const shell = page.getByTestId("mobile-shell");
  await shell.getByRole("button", { name: "Docker", exact: true }).click();
  const list = shell.getByTestId("container-list");
  await list.getByRole("button", { name: /^jellyfin/ }).click();
  const detail = shell.getByTestId("container-detail");
  await expect(detail.getByRole("heading", { name: "jellyfin", exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Durdur", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Yeniden başlat", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("tab", { name: "Günlükler", exact: true })).toHaveCount(0);
  const session = (await (await page.request.get("/api/auth/session")).json()) as {
    csrfToken: string;
  };
  const containers = (await (await page.request.get("/api/docker/containers")).json()) as {
    containers: Array<{ id: string; name: string }>;
  };
  const id = containers.containers.find((container) => container.name === "jellyfin")!.id;
  expect(
    (
      await page.request.post(`/api/docker/containers/${id}/actions`, {
        headers: { "x-everyos-csrf": session.csrfToken },
        data: { action: "stop" },
      })
    ).status(),
  ).toBe(403);
  expect((await page.request.get(`/api/docker/containers/${id}/logs`)).status()).toBe(403);
  await detail.getByRole("button", { name: "Geri", exact: true }).click();
  await expect(list).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath("docker-mobile-viewer.png"),
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});
