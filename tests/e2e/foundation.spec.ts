import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CSRF_HEADER } from "../../packages/shared/src/index.ts";
import { PASSWORD, preferences, signIn, stateDir } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

test("first-run setup creates the administrator and opens the shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Otuken'e hoş geldiniz" })).toBeVisible();

  // Turkish is preselected; continue to token verification.
  await expect(page.getByRole("radio", { name: "Türkçe" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Devam et" }).click();

  const token = readFileSync(join(stateDir, "data/setup-token"), "utf8").trim();
  await page.getByLabel("Kurulum anahtarı").fill("yanlis-anahtar");
  await page.getByRole("button", { name: "Devam et" }).click();

  await page.getByLabel("Kullanıcı adı").fill("goktug");
  await page.getByLabel("Görünen ad").fill("Göktuğ");
  await page.getByLabel("Parola", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Parola (tekrar)").fill(PASSWORD);
  await page.getByRole("button", { name: "Kurulumu tamamla" }).click();

  // A wrong token sends the user back to the verification step with an error.
  await expect(page.getByText("Kurulum anahtarı hatalı.")).toBeVisible();
  await page.getByLabel("Kurulum anahtarı").fill(token);
  await page.getByRole("button", { name: "Devam et" }).click();
  await page.getByRole("button", { name: "Kurulumu tamamla" }).click();

  await expect(page.getByTestId("desktop")).toBeVisible();
  await page
    .getByTestId("dock")
    .getByRole("button", { name: "Sistem İzleyici", exact: true })
    .click();
  await page.getByRole("tab", { name: "Bilgi", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sistem", exact: true })).toBeVisible();
  await expect(page.getByText("Gerçek veri")).toBeVisible();
  await expect(page.getByText("Ajan bağlı")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("desktop.png"), animations: "disabled" });
});

test("sign out and sign back in, switching the language", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Oturum açın" })).toBeVisible();

  await page.getByLabel("Kullanıcı adı").fill("goktug");
  await page.getByLabel("Parola", { exact: true }).fill("yanlis-parola-123");
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page.getByText("Kullanıcı adı veya parola hatalı.")).toBeVisible();

  await page.getByLabel("Parola", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page.getByTestId("desktop")).toBeVisible();

  // Switch to English; the preference is saved to the account.
  await page.getByTestId("dock").getByRole("button", { name: "Ayarlar", exact: true }).click();
  await page
    .locator('[data-app-id="otuken.settings"]')
    .getByRole("button", { name: "Hesap", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Arayüz dili" }).selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await page.getByRole("button", { name: "User menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  // The saved preference is applied after the next sign-in, too.
  await page.getByLabel("Username").fill("goktug");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("desktop")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("session survives a page reload and the API rejects cross-site requests", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByLabel(/Kullanıcı adı|Username/).fill("goktug");
  await page.getByLabel(/^(Parola|Password)$/).fill(PASSWORD);
  await page.getByRole("button", { name: /Giriş yap|Sign in/ }).click();
  await expect(page.getByTestId("desktop")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("desktop")).toBeVisible();

  const crossSite = await request.post("/api/auth/login", {
    headers: { origin: "https://evil.example" },
    data: { username: "goktug", password: PASSWORD },
  });
  expect(crossSite.status()).toBe(403);
});

test("windows drag, resize, snap, minimize and restore their layout after reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const system = page.locator('[data-app-id="otuken.system"]');
  const dockButton = page
    .getByTestId("dock")
    .getByRole("button", { name: "Sistem İzleyici", exact: true });
  await dockButton.click();
  await expect(system.getByRole("tab", { name: "Genel bakış", exact: true })).toBeVisible();
  const initial = (await system.boundingBox())!;
  const title = (await system.locator("header").boundingBox())!;
  await page.mouse.move(title.x + 160, title.y + 20);
  await page.mouse.down();
  await page.mouse.move(title.x + 260, title.y + 80, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await system.boundingBox())!.x).toBeCloseTo(initial.x + 100, 0);
  const moved = (await system.boundingBox())!;
  const corner = (await system.locator('[data-resize-edge="se"]').boundingBox())!;
  await page.mouse.move(corner.x + 4, corner.y + 4);
  await page.mouse.down();
  await page.mouse.move(corner.x + 84, corner.y + 44, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await system.boundingBox())!.width)
    .toBeCloseTo(moved.width + 80, 0);
  await expect
    .poll(async () => (await system.boundingBox())!.height)
    .toBeCloseTo(moved.height + 40, 0);
  await page.keyboard.press("Control+Alt+ArrowLeft");
  await expect(system).toHaveAttribute("data-layout", "left");
  const snappedTitle = (await system.locator("header").boundingBox())!;
  await page.mouse.move(snappedTitle.x + 160, snappedTitle.y + 20);
  await page.mouse.down();
  await page.mouse.move(1438, 240, { steps: 20 });
  await page.mouse.up();
  await expect(system).toHaveAttribute("data-layout", "right");
  await dockButton.click();
  await expect(system).toBeHidden();
  await dockButton.click();
  await expect(system).toBeVisible();
  await expect
    .poll(async () => (await preferences(page)).windows?.windows[0]?.layout)
    .toBe("right");
  const saved = (await system.boundingBox())!;
  await page.reload();
  await expect(system).toBeVisible();
  await expect(system).toHaveAttribute("data-layout", "right");
  await expect.poll(async () => (await system.boundingBox())!.x).toBeCloseTo(saved.x, 0);
  await system.getByRole("button", { name: "Büyüt", exact: true }).click();
  await expect(system).toHaveAttribute("data-layout", "maximized");
  await system.getByRole("button", { name: "Önceki boyut", exact: true }).click();
  await expect(system).toHaveAttribute("data-layout", "floating");
});

test("all seven themes and render modes apply and persist", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Hızlı ayarlar", exact: true }).click();
  const themes = [
    ["Liquid Dark", "liquid-dark"],
    ["Frost Blue", "frost-blue"],
    ["Graphite Glass", "graphite-glass"],
    ["Aurora", "aurora"],
    ["Minimal Clear", "minimal-clear"],
    ["Neon Night", "neon-night"],
    ["Liquid Light", "liquid-light"],
  ] as const;
  for (const [name, id] of themes) {
    await page.getByRole("radio", { name, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
  }
  await page.getByRole("radio", { name: "Performans", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-render", "performance");
  await expect.poll(async () => (await preferences(page)).appearance?.themeId).toBe("liquid-light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "liquid-light");
  await expect(page.locator("html")).toHaveAttribute("data-render", "performance");
});

test("desktop context menus create folders, move icons and persist them", async ({ page }) => {
  await signIn(page);
  const surface = page.getByTestId("desktop-surface");
  await surface.click({ button: "right", position: { x: 550, y: 250 } });
  await page.getByRole("menuitem", { name: "Yeni klasör", exact: true }).click();
  await page.getByRole("textbox", { name: "Yeniden adlandır", exact: true }).fill("Araçlar");
  await page.keyboard.press("Enter");
  const folder = surface.getByRole("button", { name: "Araçlar", exact: true });
  await expect(folder).toBeVisible();
  const system = surface.getByRole("button", { name: "Sistem İzleyici", exact: true });
  const icon = (await system.boundingBox())!;
  await page.mouse.move(icon.x + 30, icon.y + 30);
  await page.mouse.down();
  await page.mouse.move(360, 160, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await system.boundingBox())!.x).toBeGreaterThan(250);
  await system.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Klasöre taşı", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Araçlar", exact: true }).click();
  await expect(system).toBeHidden();
  await folder.dblclick();
  await expect(
    page
      .locator('[data-app-id="otuken.folder"]')
      .getByRole("button", { name: "Sistem İzleyici", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      (await preferences(page)).desktop?.items.some(
        (item) => item.kind === "folder" && item.name === "Araçlar",
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(folder).toBeVisible();
  await expect(system).toBeHidden();
});

test("launcher search, virtual desktops and dock menus use the same window state", async ({
  page,
}) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("donanım");
  await page.keyboard.press("Enter");
  const system = page.locator('[data-app-id="otuken.system"]');
  await expect(system).toBeVisible();
  await page.getByRole("button", { name: "Masaüstü ekle", exact: true }).click();
  await expect(system).toBeHidden();
  await page
    .getByTestId("dock")
    .getByRole("button", { name: "Sistem İzleyici", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Sistem İzleyici", exact: true }).click();
  await expect(system).toBeVisible();
  await page
    .getByTestId("dock")
    .getByRole("button", { name: "Sistem İzleyici", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Dock'tan kaldır", exact: true }).click();
  await expect
    .poll(async () => (await preferences(page)).dock?.pinned.includes("otuken.system"))
    .toBe(false);
  await expect.poll(async () => (await preferences(page)).desktop?.desktops.length).toBe(2);
  await page.reload();
  await expect(
    page.getByRole("group", { name: "Masaüstleri", exact: true }).getByRole("button"),
  ).toHaveCount(3);
});

test("locking is enforced by the API and survives reload without losing windows", async ({
  page,
}) => {
  await signIn(page);
  await page
    .getByTestId("dock")
    .getByRole("button", { name: "Sistem İzleyici", exact: true })
    .click();
  await expect.poll(async () => (await preferences(page)).windows?.windows.length).toBe(1);
  await page.keyboard.press("Control+Alt+l");
  await expect(page.getByTestId("lock-screen")).toBeVisible();
  expect((await page.request.get("/api/system/info")).status()).toBe(423);
  await page.reload();
  const lock = page.getByTestId("lock-screen");
  await expect(lock).toBeVisible();
  await lock.getByLabel("Parola", { exact: true }).fill("yanlis-parola-123");
  await lock.getByRole("button", { name: "Kilidi aç", exact: true }).click();
  await expect(lock.getByText("Kullanıcı adı veya parola hatalı.")).toBeVisible();
  await lock.getByLabel("Parola", { exact: true }).fill(PASSWORD);
  await lock.getByRole("button", { name: "Kilidi aç", exact: true }).click();
  await expect(lock).toBeHidden();
  await expect(page.locator('[data-app-id="otuken.system"]')).toBeVisible();
  expect((await page.request.get("/api/system/info")).status()).toBe(200);
});

test("desktop and mobile transitions preserve windows and mobile settings are saved", async ({
  page,
}) => {
  await signIn(page);
  await page
    .getByTestId("dock")
    .getByRole("button", { name: "Sistem İzleyici", exact: true })
    .click();
  await expect(page.locator('[data-app-id="otuken.system"]')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("mobile-shell")).toBeVisible();
  await page.getByRole("button", { name: "Ayarlar", exact: true }).click();
  await page.getByRole("radio", { name: "Aurora", exact: true }).click();
  await page.screenshot({ path: test.info().outputPath("mobile.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Geri", exact: true }).click();
  await page.getByRole("button", { name: "Oturumu kapat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Oturum açın" })).toBeVisible();
  await signIn(page, false);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aurora");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByTestId("desktop")).toBeVisible();
  await expect(page.locator('[data-app-id="otuken.system"]')).toBeVisible();
});

test("a failed preferences load shows an error and recovers without replacing saved data", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "Hızlı ayarlar", exact: true }).click();
  await page.getByRole("radio", { name: "Neon Night", exact: true }).click();
  await expect.poll(async () => (await preferences(page)).appearance?.themeId).toBe("neon-night");
  await page.route("**/api/preferences", (route) => route.abort());
  await page.reload();
  await expect(page.getByText("Sunucuya ulaşılamıyor. Bağlantınızı kontrol edin.")).toBeVisible();
  await page.unroute("**/api/preferences");
  await page.getByRole("button", { name: "Tekrar dene", exact: true }).click();
  await expect(page.getByTestId("desktop")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "neon-night");
});

test("users and audit use real records, and mobile sign-out clears another user's preferences", async ({
  page,
}) => {
  await signIn(page);
  await page.getByTestId("dock").getByRole("button", { name: "Kullanıcılar", exact: true }).click();
  await page.getByRole("button", { name: "Kullanıcı ekle", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Kullanıcı ekle", exact: true });
  await dialog.getByLabel("Kullanıcı adı", { exact: true }).fill("izleyici");
  await dialog.getByLabel("Görünen ad", { exact: true }).fill("İzleyici");
  await dialog.getByLabel("Başlangıç parolası", { exact: true }).fill(PASSWORD);
  await dialog.getByRole("combobox", { name: "Rol", exact: true }).selectOption("viewer");
  await dialog.getByRole("button", { name: "Oluştur", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "@izleyici" })).toBeVisible();
  await page
    .getByTestId("dock")
    .getByRole("button", { name: "Denetim Kaydı", exact: true })
    .click();
  await expect(
    page.locator('[data-app-id="otuken.audit"]').getByText("users.create", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hızlı ayarlar", exact: true }).click();
  await page.getByRole("radio", { name: "Aurora", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Oturumu kapat", exact: true }).click();
  await page.getByLabel("Kullanıcı adı", { exact: true }).fill("izleyici");
  await page.getByLabel("Parola", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Giriş yap", exact: true }).click();
  await expect(page.getByTestId("mobile-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "liquid-dark");
  await expect(page.getByRole("button", { name: "Kullanıcılar", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Denetim Kaydı", exact: true })).toHaveCount(0);
  expect((await page.request.get("/api/users")).status()).toBe(403);
  expect((await page.request.get("/api/audit")).status()).toBe(403);
  await page.getByRole("button", { name: "Ayarlar", exact: true }).click();
  await page.getByRole("radio", { name: "Liquid Light", exact: true }).click();
  await expect.poll(async () => (await preferences(page)).appearance?.themeId).toBe("liquid-light");
});

test("dragging remains responsive with ten real desktop folder windows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const session = await signIn(page);
  const headers = { [CSRF_HEADER]: session.csrfToken };
  const items = Array.from({ length: 10 }, (_, index) => ({
    kind: "folder",
    id: `f${index}`,
    name: `Folder ${index + 1}`,
    desktopId: "d1",
    cell: { col: 0, row: index },
  }));
  expect(
    (
      await page.request.put("/api/preferences/desktop", {
        headers,
        data: {
          version: 1,
          desktops: [{ id: "d1", name: "Ana", wallpaper: null }],
          items,
        },
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await page.request.put("/api/preferences/windows", {
        headers,
        data: {
          version: 1,
          viewport: { width: 1440, height: 900 },
          activeDesktopId: "d1",
          windows: items.map((item, index) => ({
            id: `w${index}`,
            appId: "otuken.folder",
            desktopId: "d1",
            title: item.name,
            bounds: { x: 200 + index * 25, y: 80 + index * 25, width: 560, height: 360 },
            layout: "floating",
            minimized: false,
            z: index + 1,
            appState: { folderId: item.id },
          })),
        },
      })
    ).status(),
  ).toBe(204);
  await page.reload();
  await expect(page.locator('[data-app-id="otuken.folder"]')).toHaveCount(10);
  await expect(page.getByText("Bu klasör boş.", { exact: false })).toHaveCount(10);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const measurement = await page.evaluateHandle(() => {
    const durations: number[] = [];
    const observer = new PerformanceObserver((list) =>
      durations.push(...list.getEntries().map((entry) => entry.duration)),
    );
    observer.observe({ type: "longtask" });
    return { durations, observer };
  });
  const frame = page.locator('[data-window-id="w9"]');
  const initial = (await frame.boundingBox())!;
  const title = (await frame.locator("header").boundingBox())!;
  await page.mouse.move(title.x + 140, title.y + 20);
  await page.mouse.down();
  await page.mouse.move(title.x + 330, title.y + 120, { steps: 40 });
  await page.mouse.up();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const durations = await measurement.evaluate(({ durations, observer }) => {
    durations.push(...observer.takeRecords().map((entry) => entry.duration));
    observer.disconnect();
    return durations;
  });
  await measurement.dispose();
  await test.info().attach("ten-window-long-tasks", {
    body: JSON.stringify({ windowCount: 10, longTaskDurationsMs: durations }),
    contentType: "application/json",
  });
  expect(durations.filter((duration) => duration > 50)).toEqual([]);
  await expect.poll(async () => (await frame.boundingBox())!.x).toBeCloseTo(initial.x + 190, 0);
});
