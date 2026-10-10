import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

/*
 * Phase 3 host integration. The e2e stack runs the agent with
 * OTUKEN_AGENT_SIMULATE=1, so systemd and journald data come from the
 * development simulator (and are labelled as simulated); metrics, storage
 * and processes are real readings of the machine running the tests.
 */

test.describe.configure({ mode: "serial" });

test("system monitor shows live metrics, processes and storage", async ({ page }) => {
  await signIn(page);
  await page
    .getByTestId("dock")
    .getByRole("button", { name: "Sistem İzleyici", exact: true })
    .click();
  const app = page.locator('[data-app-id="otuken.system"]');
  await expect(app.getByRole("tab", { name: "Genel bakış", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const tiles = app.getByTestId("monitor-tiles");
  // CPU usage needs two samples; it appears once the live stream delivers them.
  await expect(tiles.getByText(/%\s?\d/).first()).toBeVisible({ timeout: 15_000 });
  await expect(app.getByRole("group", { name: /İşlemci grafiği/ })).toBeVisible();
  await expect(page.getByTestId("menubar-resources")).toContainText(/%\d/);
  // At least one chart draws a line once two samples exist.
  await expect
    .poll(() => app.locator('[role="group"] svg path[d*="L"]').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath("overview.png"), animations: "disabled" });

  await app.getByRole("tab", { name: "İşlemler", exact: true }).click();
  await expect(app.getByTestId("process-table").locator("tbody tr").first()).toBeVisible();

  await app.getByRole("tab", { name: "Depolama", exact: true }).click();
  await expect(app.getByRole("meter").first()).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("system-monitor.png"),
    animations: "disabled",
  });
});

test("services can be inspected and controlled, protected units cannot be stopped", async ({
  page,
}) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("servis");
  await page.keyboard.press("Enter");
  const app = page.locator('[data-app-id="otuken.services"]');
  await expect(app).toBeVisible();
  await expect(app.getByTestId("simulated-badge").first()).toBeVisible();

  const list = app.getByTestId("service-list");
  await list.getByRole("button", { name: /ssh\.service/ }).click();
  const detail = app.getByTestId("service-detail");
  await expect(detail.getByText(/yalnızca başlatılabilir/)).toBeVisible();
  // Protected units offer no disruptive or boot-configuration actions.
  for (const action of ["Durdur", "Yeniden başlat", "Açılışta başlatma", "Açılışta başlat"]) {
    await expect(detail.getByRole("button", { name: action, exact: true })).toHaveCount(0);
  }

  await app.getByRole("textbox", { name: "Servis ara" }).fill("jellyfin");
  await list.getByRole("button", { name: /jellyfin\.service/ }).click();
  await expect(detail.getByText("Etkin değil", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Başlat", exact: true }).click();
  await expect(detail.getByRole("status")).toHaveText("İstek gönderildi: Başlat");
  await expect(detail.getByText("Etkin", { exact: true })).toBeVisible();

  await detail.getByRole("button", { name: "Durdur", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Durdur", exact: true }).click();
  await expect(detail.getByText("Etkin değil", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("services.png"), animations: "disabled" });

  // Every action is in the audit log with the acting user.
  const audit = (await (await page.request.get("/api/audit?limit=20")).json()) as {
    events: Array<{ action: string; target: string; outcome: string }>;
  };
  expect(audit.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "services.start",
        target: "jellyfin.service",
        outcome: "success",
      }),
      expect.objectContaining({
        action: "services.stop",
        target: "jellyfin.service",
        outcome: "success",
      }),
    ]),
  );
});

test("logs open filtered from a service and follow new entries live", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("servis");
  await page.keyboard.press("Enter");
  const services = page.locator('[data-app-id="otuken.services"]');
  await services.getByRole("button", { name: /jellyfin\.service/ }).click();
  await services.getByRole("button", { name: "Günlükleri göster", exact: true }).click();

  const logs = page.locator('[data-app-id="otuken.logs"]');
  await expect(logs).toBeVisible();
  await expect(logs.getByRole("textbox", { name: "Servis" })).toHaveValue("jellyfin.service");
  await expect(
    logs
      .getByTestId("log-list")
      .getByText(/Simulated (start|stop) of jellyfin\.service/)
      .first(),
  ).toBeVisible();

  // Live mode: the simulator writes a new journal entry every few seconds.
  await logs.getByRole("textbox", { name: "Servis" }).fill("");
  await logs.getByRole("button", { name: "Uygula", exact: true }).click();
  const rows = logs.getByTestId("log-list").locator("li");
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  await logs.getByTestId("logs-live").click();
  await expect(logs.getByTestId("logs-live")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(before);
  await page.screenshot({ path: test.info().outputPath("logs.png"), animations: "disabled" });
});

test("event streams require an unlocked session", async ({ page }) => {
  await signIn(page, false);
  await page.keyboard.press("Control+Alt+l");
  await expect(page.getByTestId("lock-screen")).toBeVisible();
  expect((await page.request.get("/api/events?topics=metrics")).status()).toBe(423);
  expect((await page.request.get("/api/logs")).status()).toBe(423);
});
