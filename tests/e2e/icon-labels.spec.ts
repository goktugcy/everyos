import { expect, test } from "@playwright/test";
import { CSRF_HEADER, type FileRootsResponse } from "../../packages/shared/src/index.ts";
import { signIn } from "./helpers.ts";

test("selection covers icons and names while long unbroken names fit or expand completely", async ({
  page,
}) => {
  const session = await signIn(page);
  const headers = { [CSRF_HEADER]: session.csrfToken };
  const roots = (await (await page.request.get("/api/files/roots")).json()) as FileRootsResponse;
  const desktopPath = roots.roots.find((root) => root.kind === "home")!.folders!.desktop!;
  const names = ["LongSingleWordDocumentArchiveFile.txt", "VeryLong".repeat(20) + ".txt"] as const;
  for (const name of names)
    expect(
      (
        await page.request.put("/api/files/text", {
          headers,
          data: { root: "home", path: `${desktopPath}/${name}`, content: "fixture", etag: null },
        })
      ).status(),
    ).toBe(200);
  await page.reload();
  const surface = page.getByTestId("desktop-surface");
  const app = surface.getByRole("button", { name: "Ayarlar", exact: true });
  await app.click();
  await expect(app).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(app.locator("[data-icon-label]")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const ordinary = surface.getByRole("button", { name: names[0], exact: true });
  await ordinary.click();
  await expect(ordinary).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(app).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(
    await ordinary.evaluate((node) => {
      const item = node.getBoundingClientRect();
      const caption = node.querySelector(".everyos-icon-caption")!.getBoundingClientRect();
      return (
        caption.top >= item.top &&
        caption.bottom <= item.bottom &&
        caption.left >= item.left &&
        caption.right <= item.right
      );
    }),
  ).toBe(true);
  const label = ordinary.locator("[data-icon-label]");
  await expect(label).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect
    .poll(() => label.evaluate((node) => node.scrollHeight <= node.clientHeight))
    .toBe(true);
  expect(
    await label.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
  ).toBeLessThan(11.52);
  const veryLong = surface.getByRole("button", { name: names[1], exact: true });
  await veryLong.click();
  const expanded = veryLong.locator(".everyos-caption-expanded");
  await expect(expanded).toBeVisible();
  await expect(expanded).toHaveText(names[1]);
  expect(await expanded.evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
  await expect(expanded).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await surface.click({ button: "right", position: { x: 500, y: 350 } });
  await page.getByRole("menuitem", { name: "Masaüstü klasörünü aç", exact: true }).click();
  const files = page.locator('[data-app-id="everyos.files"]');
  await files.getByRole("button", { name: "Simgeler", exact: true }).click();
  const row = files.getByTestId("file-row").filter({ hasText: names[1] });
  await row.click();
  await expect(row).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(row.locator(".everyos-caption-expanded")).toBeVisible();
  await expect(row.locator("[data-icon-label]")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.screenshot({
    path: test.info().outputPath("whole-item-selection.png"),
    animations: "disabled",
  });
  // Leave the Desktop folder as it was for the tests that follow.
  expect(
    (
      await page.request.post("/api/files/delete", {
        headers,
        data: { root: "home", paths: names.map((name) => `${desktopPath}/${name}`), confirm: true },
      })
    ).status(),
  ).toBe(204);
});
