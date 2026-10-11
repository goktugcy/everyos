import { expect, test } from "@playwright/test";
import { CSRF_HEADER, type FileListing } from "../../packages/shared/src/index.ts";
import { preferences, signIn } from "./helpers.ts";

test("the pulse opens a dashboard and a shelf that takes files, and can be hidden", async ({
  page,
}) => {
  const session = await signIn(page);
  const pulse = page.getByTestId("pulse");
  // The dots draw the server's live CPU history.
  await expect(page.getByTestId("pulse-trigger").locator("svg")).toHaveAttribute(
    "data-mode",
    "graph",
  );
  await expect(pulse).toHaveAttribute("data-open", "false");

  // Dashboard: this month's calendar with today selected.
  await page.getByTestId("pulse-trigger").click();
  await expect(pulse).toHaveAttribute("data-open", "true");
  const month = new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric" }).format(
    new Date(),
  );
  await expect(page.getByTestId("pulse-month")).toHaveText(new RegExp(month, "i"));
  await expect(page.getByTestId("pulse-day")).toContainText("Bugün");
  await page.keyboard.press("Escape");
  await expect(pulse).toHaveAttribute("data-open", "false");

  // Shelf: files dropped from the computer are uploaded, never overwritten.
  await page.getByTestId("pulse-trigger").click();
  await page.getByTestId("pulse-tab-shelf").click();
  // Uploads go to the user's own Downloads folder by default.
  await expect(page.getByTestId("pulse-shelf")).toContainText("İndirilenler");
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["merhaba"], "pulse-e2e.txt", { type: "text/plain" }));
    return transfer;
  });
  const items = page.getByTestId("pulse-shelf-item");
  await page.dispatchEvent('[data-testid="pulse-dropzone"]', "drop", { dataTransfer });
  await expect(items.filter({ hasText: "pulse-e2e.txt" })).toBeVisible();
  await page.dispatchEvent('[data-testid="pulse-dropzone"]', "drop", { dataTransfer });
  await expect(items.filter({ hasText: "pulse-e2e (2).txt" })).toBeVisible();
  const listing = (await (
    await page.request.get(`/api/files/list?root=home&path=${encodeURIComponent("İndirilenler")}`)
  ).json()) as FileListing;
  expect(listing.entries.map((entry) => entry.name)).toEqual(
    expect.arrayContaining(["pulse-e2e.txt", "pulse-e2e (2).txt"]),
  );
  // The shelf is a preference: it follows the user to other browsers.
  await expect
    .poll(async () => (await preferences(page)).pulse?.shelf.map((item) => item.path))
    .toEqual(["İndirilenler/pulse-e2e (2).txt", "İndirilenler/pulse-e2e.txt"]);

  // Removing from the shelf keeps the file.
  const second = items.filter({ hasText: "pulse-e2e (2).txt" });
  await second.hover();
  await second.getByRole("button", { name: "pulse-e2e (2).txt öğesini raftan kaldır" }).click();
  await expect(second).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Dragging from a Files window puts a reference on the shelf.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("dosyalar");
  await page.keyboard.press("Enter");
  const files = page.locator('[data-app-id="everyos.files"]');
  await files.getByTestId("files-sidebar").getByRole("button", { name: "İndirilenler" }).click();
  const row = files.getByTestId("file-row").filter({ hasText: "pulse-e2e (2).txt" });
  await row.dragTo(page.getByTestId("pulse-trigger"));
  await expect(pulse).toHaveAttribute("data-open", "true");
  await expect(items.filter({ hasText: "pulse-e2e (2).txt" })).toBeVisible();

  // Hidden from the panel, back from quick settings.
  await page.getByRole("button", { name: "Nabzı gizle" }).click();
  await expect(pulse).toHaveCount(0);
  await page.getByRole("button", { name: "Hızlı ayarlar" }).click();
  await page.getByRole("switch", { name: "Menü çubuğu nabzı" }).click();
  await expect(pulse).toBeVisible();

  // Leave the shared file location as it was for the other specs.
  expect(
    (
      await page.request.post("/api/files/delete", {
        headers: { [CSRF_HEADER]: session.csrfToken },
        data: {
          root: "home",
          paths: ["İndirilenler/pulse-e2e.txt", "İndirilenler/pulse-e2e (2).txt"],
          confirm: true,
        },
      })
    ).status(),
  ).toBe(204);
});
