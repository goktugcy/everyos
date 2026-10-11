import { expect, test } from "@playwright/test";
import {
  CSRF_HEADER,
  type FileRootsResponse,
  type PowerStatus,
} from "../../packages/shared/src/index.ts";
import { preferences, signIn } from "./helpers.ts";

test("folder presets and private uploads persist across views and power details show Linux readings", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const session = await signIn(page);
  const headers = { [CSRF_HEADER]: session.csrfToken };
  await page.goto("about:blank");
  const roots = (await (await page.request.get("/api/files/roots")).json()) as FileRootsResponse;
  const desktop = roots.roots.find((root) => root.kind === "home")!.folders!.desktop!;
  expect(
    (
      await page.request.post("/api/files/mkdir", {
        headers,
        data: { root: "home", path: desktop, name: "icon-work" },
      })
    ).status(),
  ).toBe(201);
  await page.goto("/");
  const surface = page.getByTestId("desktop-surface");
  let folder = surface.getByRole("button", { name: "icon-work", exact: true, includeHidden: true });
  await folder.click();
  await expect(folder).toHaveAttribute("aria-pressed", "true");
  await expect(folder.locator(".otk-icon-label")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await folder.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Klasör simgesini değiştir…", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "icon-work · Klasör simgesi", exact: true });
  await dialog.getByRole("radio", { name: "Yeşil", exact: true }).click();
  await expect(folder.locator('[data-folder-icon="green"]')).toBeVisible();
  await dialog.getByRole("button", { name: "Kapat", exact: true }).click();
  await folder.press("F2");
  await folder.getByRole("textbox", { name: "Yeniden adlandır", exact: true }).fill("icon-renamed");
  await folder.getByRole("textbox").press("Enter");
  folder = surface.getByRole("button", { name: "icon-renamed", exact: true, includeHidden: true });
  await expect(folder.locator('[data-folder-icon="green"]')).toBeVisible();
  await expect
    .poll(async () => (await preferences(page)).appearance?.folderIcons?.[0]?.path)
    .toBe(`${desktop}/icon-renamed`);
  await folder.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Klasör simgesini değiştir…", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "icon-renamed · Klasör simgesi", exact: true });
  // A real raster image is uploaded through the authenticated streaming endpoint.
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "icon.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQOhr3HwAElwJF/XRl9gAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await expect(folder.locator('[data-folder-icon="uploaded"] img')).toBeVisible();
  await expect
    .poll(async () => (await preferences(page)).appearance?.folderIcons?.[0]?.icon.kind)
    .toBe("uploaded");
  await dialog.getByRole("button", { name: "Kapat", exact: true }).click();
  await page.reload();
  await expect(folder.locator('[data-folder-icon="uploaded"] img')).toBeVisible();
  await expect
    .poll(
      async () =>
        await folder
          .locator('[data-folder-icon="uploaded"] img')
          .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  await folder.dblclick();
  const files = page.locator('[data-app-id="otuken.files"]');
  await files
    .getByTestId("files-sidebar")
    .getByRole("button", { name: desktop, exact: true })
    .click();
  const row = files.getByTestId("file-row").filter({ hasText: "icon-renamed" });
  for (const mode of ["Simgeler", "Liste"]) {
    await files.getByRole("button", { name: mode, exact: true }).click();
    await expect(row.locator('[data-folder-icon="uploaded"] img')).toBeVisible();
  }
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Klasör simgesini değiştir…", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "icon-renamed · Klasör simgesi", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Varsayılan simgeyi kullan", exact: true }).click();
  await dialog.getByRole("button", { name: "Kapat", exact: true }).click();
  await expect(row.locator('[data-folder-icon="classic"]')).toBeVisible();
  await files.getByRole("button", { name: "Kapat", exact: true }).first().click();
  await page.getByRole("button", { name: "Hızlı ayarlar", exact: true }).click();
  await page.getByRole("button", { name: "Tüm görünüm ayarları…", exact: true }).click();
  const settings = page.locator('[data-app-id="otuken.settings"]');
  await settings.getByRole("radio", { name: "Kehribar", exact: true }).click();
  await expect(folder.locator('[data-folder-icon="amber"]')).toBeVisible();
  await expect
    .poll(async () => (await preferences(page)).appearance?.folderIcon)
    .toEqual({ kind: "preset", id: "amber" });
  await settings.getByRole("button", { name: "Kapat", exact: true }).first().click();
  const realPower = (await (await page.request.get("/api/system/power")).json()) as PowerStatus;
  expect(realPower.source).toBe("host");
  const measured: PowerStatus = {
    source: "host",
    at: Date.now(),
    available: true,
    acConnected: true,
    batteries: [
      {
        id: "BAT0",
        percent: 75,
        state: "charging",
        powerWatts: 20,
        voltageVolts: 12,
        currentAmps: 1.5,
        energyWh: 45,
        fullEnergyWh: 60,
        timeToEmptySeconds: null,
        timeToFullSeconds: null,
      },
    ],
    supplies: [{ id: "AC", online: true, powerWatts: null, powerLimitWatts: 65 }],
  };
  // A Linux fixture exercises states unavailable on the macOS development host.
  await page.route("**/api/system/power", (route) => route.fulfill({ json: measured }));
  await page.reload();
  const power = page.getByTestId("menubar-power");
  await expect(power).toHaveText(/75/);
  await expect(power.locator(".lucide-plug-zap")).toBeVisible();
  await power.click();
  await expect(page.getByText("Şarj oluyor", { exact: true })).toBeVisible();
  await expect(page.getByText("20 W", { exact: true })).toBeVisible();
  await expect(page.getByText("65 W", { exact: true })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("power-folder-icons.png"),
    animations: "disabled",
  });
});
