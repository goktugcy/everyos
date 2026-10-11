import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

/** A 2×2 PNG, so the icon view has a real thumbnail to show. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4AWP4z8DwnwEJMDAwMDAwAAAa+AH/0tZpNwAAAABJRU5ErkJggg==",
  "base64",
);

test("Files looks like Finder: fixed favourites, icon and list views, terminal and system places", async ({
  page,
}) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("dosyalar");
  await page.keyboard.press("Enter");
  const files = page.locator('[data-app-id="everyos.files"]');
  const sidebar = files.getByTestId("files-sidebar");
  const row = (name: string) => files.getByTestId("file-row").filter({ hasText: name });

  // The home opens first, with its fixed standard folders as icons.
  await expect(sidebar).toContainText("Favoriler");
  for (const name of ["Masaüstü", "Belgeler", "İndirilenler", "Resimler", "Müzik", "Videolar"])
    await expect(sidebar.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(files.getByTestId("files-title")).toHaveText("goktug");
  await expect(files.getByTestId("file-icons")).toBeVisible();

  // Standard folders cannot be deleted.
  await row("Resimler").click();
  await files.getByTestId("file-list").press("Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "Çöp kutusuna taşı" }).click();
  await expect(files).toContainText("Standart klasörler yeniden adlandırılamaz");
  await expect(row("Resimler")).toBeVisible();

  // Pictures get thumbnails in the icon view; the list view shows details.
  await sidebar.getByRole("button", { name: "Resimler", exact: true }).click();
  await expect(files.getByTestId("files-title")).toHaveText("Resimler");
  await files
    .locator('input[type="file"]')
    .setInputFiles({ name: "kare.png", mimeType: "image/png", buffer: PNG });
  await expect(files.getByTestId("file-icons").locator("img")).toHaveCount(1);
  await files.getByRole("button", { name: "Liste" }).click();
  await expect(files.locator("table")).toContainText("kare.png");
  await files.getByRole("button", { name: "Simgeler" }).click();
  await row("kare.png").click();
  await files.getByTestId("file-list").press("Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "Çöp kutusuna taşı" }).click();
  await expect(row("kare.png")).toHaveCount(0);

  // "Open Terminal" from the folder's context menu.
  await files.getByTestId("file-list").click({ button: "right", position: { x: 300, y: 200 } });
  await page.getByRole("menuitem", { name: "Terminal aç" }).click();
  const terminal = page.locator('[data-app-id="everyos.terminal"]');
  await expect(terminal).toHaveCount(1);
  await terminal.locator('button[data-kind="close"]').click();
  await expect(terminal).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get("/api/terminal/sessions")).json()) as {
            sessions: unknown[];
          }
        ).sessions.length,
    )
    .toBe(0);

  // System places: only after an administrator turns them on, and read-only.
  await sidebar.getByRole("button", { name: "Sistem konumlarını göster…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Göster" }).click();
  await sidebar.getByRole("button", { name: "Bilgisayar" }).click();
  await expect(files.getByTestId("files-title")).toHaveText("/");
  await expect(row("etc")).toBeVisible();
  await expect(files.getByRole("button", { name: "Yeni klasör", exact: true })).toBeDisabled();
  await sidebar.getByRole("button", { name: "Sistem konumlarını gizle" }).click();
  await expect(sidebar.getByRole("button", { name: "Bilgisayar" })).toHaveCount(0);
  await expect(files.getByTestId("files-title")).toHaveText("goktug");

  // The desktop's context menu offers the terminal too.
  await files.locator('button[data-kind="close"]').click();
  await page
    .getByTestId("desktop-surface")
    .click({ button: "right", position: { x: 550, y: 250 } });
  await expect(page.getByRole("menuitem", { name: "Terminal aç" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("files drag between Files windows and the desktop, which is the Desktop folder", async ({
  page,
}) => {
  await signIn(page);
  const surface = page.getByTestId("desktop-surface");
  const onDesktop = (name: string) => surface.getByRole("button", { name, exact: true });
  const listing = async (path: string) =>
    (
      (await (
        await page.request.get(`/api/files/list?root=home&path=${encodeURIComponent(path)}`)
      ).json()) as { entries: { name: string }[] }
    ).entries.map((entry) => entry.name);

  // A folder made on the desktop, and a file in Documents.
  await surface.click({ button: "right", position: { x: 550, y: 250 } });
  await page.getByRole("menuitem", { name: "Yeni klasör", exact: true }).click();
  await page.getByRole("textbox", { name: "Yeniden adlandır", exact: true }).fill("Taşınacaklar");
  await page.keyboard.press("Enter");
  await expect(onDesktop("Taşınacaklar")).toBeVisible();

  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("dosyalar");
  await page.keyboard.press("Enter");
  const files = page.locator('[data-app-id="everyos.files"]');
  await files.getByTestId("files-sidebar").getByRole("button", { name: "Belgeler" }).click();
  await expect(files.getByTestId("files-title")).toHaveText("Belgeler");
  await files
    .locator('input[type="file"]')
    .setInputFiles({ name: "taslak.txt", mimeType: "text/plain", buffer: Buffer.from("taslak") });
  const row = files.getByTestId("file-row").filter({ hasText: "taslak.txt" });
  await expect(row).toBeVisible();

  // Dropping onto the desktop moves the file into the Desktop folder.
  const window = (await files.boundingBox())!;
  const free =
    window.x > 260 ? { x: window.x - 120, y: 420 } : { x: window.x + window.width + 60, y: 420 };
  await row.dragTo(surface, { targetPosition: free });
  await expect(onDesktop("taslak.txt")).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(await listing("Masaüstü")).toEqual(expect.arrayContaining(["taslak.txt", "Taşınacaklar"]));

  // Dropping a desktop icon onto a desktop folder moves it inside.
  await files.locator('button[data-kind="close"]').click();
  await expect(files).toHaveCount(0);
  await onDesktop("taslak.txt").dragTo(onDesktop("Taşınacaklar"));
  await expect(onDesktop("taslak.txt")).toHaveCount(0);
  await expect.poll(() => listing("Masaüstü/Taşınacaklar")).toEqual(["taslak.txt"]);

  // The folder opens in a Files window, with the sidebar.
  await onDesktop("Taşınacaklar").dblclick();
  await expect(files.getByTestId("files-title")).toHaveText("Taşınacaklar");
  await expect(files.getByTestId("file-row").filter({ hasText: "taslak.txt" })).toBeVisible();
  await expect(files.getByTestId("files-sidebar")).toContainText("Masaüstü");
  await files.locator('button[data-kind="close"]').click();

  // Deleted from the desktop (with the file inside).
  await onDesktop("Taşınacaklar").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Çöp kutusuna taşı", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Çöp kutusuna taşı" }).click();
  await expect(onDesktop("Taşınacaklar")).toHaveCount(0);
  await expect.poll(() => listing("Masaüstü")).toEqual([]);
});
