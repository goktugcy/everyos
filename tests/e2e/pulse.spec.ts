import { expect, test } from "@playwright/test";
import {
  CSRF_HEADER,
  type FileListing,
  type TrashListing,
} from "../../packages/shared/src/index.ts";
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

  // Shelf: files dropped from the computer wait on it (never overwritten), not in a folder.
  const headers = { [CSRF_HEADER]: session.csrfToken };
  const names = async (path: string, hidden = false) =>
    (
      (await (
        await page.request.get(
          `/api/files/list?root=home&path=${encodeURIComponent(path)}${hidden ? "&hidden=true" : ""}`,
        )
      ).json()) as FileListing
    ).entries
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("pulse-e2e"))
      .sort();
  await page.getByTestId("pulse-trigger").click();
  await page.getByTestId("pulse-tab-shelf").click();
  await expect(page.getByTestId("pulse-dropzone")).toContainText("geçici olarak");
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
  expect(await names(".everyos-shelf", true)).toEqual(["pulse-e2e (2).txt", "pulse-e2e.txt"]);
  expect(await names("İndirilenler")).toEqual([]);
  // The shelf is a preference: it follows the user to other browsers.
  await expect
    .poll(async () => (await preferences(page)).pulse?.shelf.map((item) => item.path))
    .toEqual([".everyos-shelf/pulse-e2e (2).txt", ".everyos-shelf/pulse-e2e.txt"]);

  // Removing a waiting file deletes it for good, without a copy in the trash.
  const second = items.filter({ hasText: "pulse-e2e (2).txt" });
  await second.hover();
  await second.getByRole("button", { name: "pulse-e2e (2).txt dosyasını sil" }).click();
  await expect(second).toHaveCount(0);
  await expect.poll(() => names(".everyos-shelf", true)).toEqual(["pulse-e2e.txt"]);
  const trash = (await (await page.request.get("/api/files/trash")).json()) as TrashListing;
  expect(trash.entries.filter((entry) => entry.name.startsWith("pulse-e2e"))).toEqual([]);
  await page.keyboard.press("Escape");

  // Moved into a folder (here by Files' API), it is an ordinary file and leaves the shelf.
  expect(
    (
      await page.request.post("/api/files/move", {
        headers,
        data: {
          root: "home",
          paths: [".everyos-shelf/pulse-e2e.txt"],
          destination: { root: "home", path: "İndirilenler" },
        },
      })
    ).status(),
  ).toBe(204);
  await page.getByTestId("pulse-trigger").click();
  await page.getByTestId("pulse-tab-shelf").click();
  await expect(page.getByTestId("pulse-shelf")).toContainText("Raf boş");
  expect(await names("İndirilenler")).toEqual(["pulse-e2e.txt"]);
  await page.keyboard.press("Escape");

  // Dragging from a Files window puts a reference on the shelf; removing it keeps the file.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("dosyalar");
  await page.keyboard.press("Enter");
  const files = page.locator('[data-app-id="everyos.files"]');
  await files.getByTestId("files-sidebar").getByRole("button", { name: "İndirilenler" }).click();
  const row = files.getByTestId("file-row").filter({ hasText: "pulse-e2e.txt" });
  await row.dragTo(page.getByTestId("pulse-trigger"));
  await expect(pulse).toHaveAttribute("data-open", "true");
  const reference = items.filter({ hasText: "pulse-e2e.txt" });
  await expect(reference).toHaveAttribute("data-temporary", "false");
  await reference.hover();
  await reference.getByRole("button", { name: "pulse-e2e.txt öğesini raftan kaldır" }).click();
  await expect(reference).toHaveCount(0);
  expect(await names("İndirilenler")).toEqual(["pulse-e2e.txt"]);

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
        headers,
        data: {
          root: "home",
          paths: ["İndirilenler/pulse-e2e.txt"],
          confirm: true,
        },
      })
    ).status(),
  ).toBe(204);
});
