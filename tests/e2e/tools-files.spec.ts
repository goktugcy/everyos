import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

test("files can be created, uploaded, edited, moved, duplicated, downloaded and deleted", async ({
  page,
}) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("dosyalar");
  await page.keyboard.press("Enter");
  const files = page.locator('[data-app-id="otuken.files"]');
  await expect(files.getByTestId("files-app")).toBeVisible();
  // Work in the configured location; the home's standard folders are fixed.
  await files
    .getByTestId("files-sidebar")
    .getByRole("button", { name: "Development files" })
    .click();
  const rows = files.getByTestId("file-row");
  const row = (name: string) => rows.filter({ hasText: name });

  // New folder with inline rename.
  await files.getByRole("button", { name: "Yeni klasör" }).click();
  const rename = files.getByRole("textbox", { name: "Yeniden adlandır" });
  await rename.fill("Arşiv");
  await rename.press("Enter");
  await expect(row("Arşiv")).toBeVisible();

  // Upload through the file picker (streamed, with progress in the status bar).
  await files.locator('input[type="file"]').setInputFiles({
    name: "rapor.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("İlk satır\n"),
  });
  await expect(files.getByTestId("upload-status")).toContainText("Yükleme tamamlandı: 1/1");
  await expect(row("rapor.txt")).toBeVisible();

  // Text files open in the editor; Ctrl+S saves.
  await row("rapor.txt").dblclick();
  const editor = page.locator('[data-app-id="otuken.editor"]');
  const text = editor.getByRole("textbox", { name: "rapor.txt içeriği" });
  await expect(text).toHaveValue("İlk satır\n");
  await text.focus();
  await text.evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length),
  );
  await text.pressSequentially("ikinci satır");
  await text.press("Control+s");
  await expect(editor).toContainText("Kaydedildi");
  const saved = (await (
    await page.request.get("/api/files/text?root=dev&path=rapor.txt")
  ).json()) as { content: string };
  expect(saved.content).toBe("İlk satır\nikinci satır");
  await editor.getByRole("button", { name: "Kapat", exact: true }).first().click();

  // Drag the file onto the folder to move it.
  await row("rapor.txt").dragTo(row("Arşiv"));
  await expect(row("rapor.txt")).toHaveCount(0);
  await row("Arşiv").dblclick();
  await expect(files.getByRole("button", { name: "Arşiv" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(row("rapor.txt")).toBeVisible();

  // Context menu: duplicate, properties, download.
  await row("rapor.txt").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Çoğalt" }).click();
  await expect(row("rapor (kopya).txt")).toBeVisible();
  await row("rapor.txt").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Özellikler" }).click();
  const properties = page.getByRole("dialog", { name: "rapor.txt" });
  await expect(properties).toContainText("/Arşiv/rapor.txt");
  await expect(properties).toContainText("rw-");
  await page.keyboard.press("Escape");
  const download = page.waitForEvent("download");
  await row("rapor.txt").click({ button: "right" });
  await page.getByRole("menuitem", { name: "İndir" }).click();
  expect((await download).suggestedFilename()).toBe("rapor.txt");

  // Search from the root finds both copies.
  await files.getByRole("button", { name: "Development files" }).first().click();
  await files.getByLabel("Bu klasörde ara").fill("rapor");
  await files.getByLabel("Bu klasörde ara").press("Enter");
  await expect(files.getByTestId("file-search-results")).toContainText("2 sonuç");
  await files.getByRole("button", { name: "Aramayı temizle" }).click();

  // Deleting asks for confirmation and moves the whole folder to recoverable trash.
  await row("Arşiv").click();
  await files.getByTestId("file-list").press("Delete");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Arşiv");
  await confirm.getByRole("button", { name: "Çöp kutusuna taşı" }).click();
  await expect(row("Arşiv")).toHaveCount(0);
  await expect(files).toContainText("Bu klasör boş.");
});

test("file changes made in the app are recorded in the audit log", async ({ page }) => {
  await signIn(page);
  const audit = (await (await page.request.get("/api/audit?limit=200")).json()) as {
    events: Array<{ action: string }>;
  };
  expect(audit.events.map((e) => e.action).filter((a) => a.startsWith("files."))).toEqual(
    expect.arrayContaining([
      "files.mkdir",
      "files.upload",
      "files.write",
      "files.move",
      "files.copy",
      "files.delete",
    ]),
  );
});
