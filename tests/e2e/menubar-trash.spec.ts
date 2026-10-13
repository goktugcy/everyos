import { expect, test } from "@playwright/test";
import {
  CSRF_HEADER,
  type FileRootsResponse,
  type TrashListing,
} from "../../packages/shared/src/index.ts";
import { preferences, signIn } from "./helpers.ts";

test("menu bar context controls persist visibility, order and clock options", async ({ page }) => {
  const session = await signIn(page);
  const headers = { [CSRF_HEADER]: session.csrfToken };
  for (const order of [["clock", "clock"], ["not-a-module"]])
    expect(
      (
        await page.request.put("/api/preferences/menubar", {
          headers,
          data: { version: 1, hidden: [], clockSeconds: false, order },
        })
      ).status(),
    ).toBe(400);
  const bar = page.getByTestId("menubar");
  await expect(bar.getByTestId("menubar-clock")).toBeVisible();
  await bar.click({ button: "right", position: { x: 230, y: 18 } });
  await page.getByRole("menuitem", { name: "Gösterilecek öğeler", exact: true }).hover();
  await page.getByRole("menuitemcheckbox", { name: "Saat", exact: true }).click();
  await expect(bar.getByTestId("menubar-clock")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await bar.focus();
  await bar.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Üst barı özelleştir", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Üst barı özelleştir", exact: true });
  const clock = dialog.locator('[data-menubar-control="clock"]');
  await clock.getByRole("switch", { name: "Saat", exact: true }).click();
  for (let index = 0; index < 9; index++)
    await clock.getByRole("button", { name: "Saat: sola taşı", exact: true }).click();
  await expect(clock.getByRole("button", { name: "Saat: sola taşı", exact: true })).toBeDisabled();
  await dialog.getByRole("switch", { name: "Saatte saniyeleri göster", exact: true }).click();
  await expect(bar.locator("[data-menubar-module]").first()).toHaveAttribute(
    "data-menubar-module",
    "clock",
  );
  await expect
    .poll(async () => {
      const pref = (await preferences(page)).menubar;
      return pref?.order?.[0] === "clock" && pref.clockSeconds && !pref.hidden.includes("clock");
    })
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath("menubar-customization.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Kapat", exact: true }).click();
  await page.reload();
  await expect(bar.locator("[data-menubar-module]").first()).toHaveAttribute(
    "data-menubar-module",
    "clock",
  );
  await expect(bar.getByTestId("menubar-clock")).toContainText(/\d{2}:\d{2}:\d{2}/);
  await bar.click({ button: "right", position: { x: 230, y: 18 } });
  await page.getByRole("menuitem", { name: "Üst barı varsayılana döndür", exact: true }).click();
  await expect(bar.locator("[data-menubar-module]").last()).toHaveAttribute(
    "data-menubar-module",
    "clock",
  );
  await expect.poll(async () => (await preferences(page)).menubar?.order).toBeUndefined();
});

test("trash icons reflect real delete, restore, empty and unavailable states", async ({ page }) => {
  const session = await signIn(page);
  const headers = { [CSRF_HEADER]: session.csrfToken };
  // The suite shares disposable file state; isolate this icon scenario from earlier deletions.
  const previous = (await (await page.request.get("/api/files/trash")).json()) as TrashListing;
  for (const root of new Set(previous.entries.map((entry) => entry.root))) {
    const ids = previous.entries.filter((entry) => entry.root === root).map((entry) => entry.id);
    for (let offset = 0; offset < ids.length; offset += 500)
      expect(
        (
          await page.request.post("/api/files/trash/delete", {
            headers,
            data: { root, ids: ids.slice(offset, offset + 500), confirm: true },
          })
        ).status(),
      ).toBe(204);
  }
  const roots = (await (await page.request.get("/api/files/roots")).json()) as FileRootsResponse;
  const desktopPath = roots.roots.find((root) => root.kind === "home")!.folders!.desktop!;
  const name = "trash-icon-note.txt";
  const path = `${desktopPath}/${name}`;
  expect(
    (
      await page.request.put("/api/files/text", {
        headers,
        data: { root: "home", path, content: "real file", etag: null },
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  const dock = page.getByTestId("dock").getByRole("button", { name: "Çöp Kutusu", exact: true });
  const icon = dock.locator("[data-trash-state]");
  await expect(icon).toHaveAttribute("data-trash-state", "empty");
  await expect(dock.locator("[data-trash-icon]")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.screenshot({
    path: test.info().outputPath("trash-empty.png"),
    animations: "disabled",
  });
  const file = page.getByTestId("desktop-surface").getByRole("button", { name, exact: true });
  await file.click();
  await file.press("Delete");
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Çöp kutusuna taşı", exact: true })
    .click();
  await expect(icon).toHaveAttribute("data-trash-state", "full");
  await dock.click();
  const trash = page.locator('[data-app-id="everyos.trash"]');
  await trash.getByLabel(`${name} öğesini seç`).check();
  await page.screenshot({ path: test.info().outputPath("trash-full.png"), animations: "disabled" });
  await trash.getByRole("button", { name: "Geri yükle", exact: true }).click();
  await expect(icon).toHaveAttribute("data-trash-state", "empty");
  expect(
    (
      await page.request.get(`/api/files/text?${new URLSearchParams({ root: "home", path })}`)
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.post("/api/files/delete", {
        headers,
        data: { root: "home", paths: [path], confirm: true },
      })
    ).status(),
  ).toBe(204);
  await trash.getByRole("button", { name: "Yenile", exact: true }).click();
  await expect(icon).toHaveAttribute("data-trash-state", "full");
  await trash.getByRole("button", { name: "Çöp kutusunu boşalt", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Kalıcı olarak sil", exact: true })
    .click();
  await expect(icon).toHaveAttribute("data-trash-state", "empty");
  await page.route("**/api/files/trash", (route) => route.abort());
  await trash.getByRole("button", { name: "Yenile", exact: true }).click();
  await expect(icon).toHaveAttribute("data-trash-state", "unknown");
  await page.unroute("**/api/files/trash");
  await trash.getByRole("button", { name: "Yenile", exact: true }).click();
  await expect(icon).toHaveAttribute("data-trash-state", "empty");
});
