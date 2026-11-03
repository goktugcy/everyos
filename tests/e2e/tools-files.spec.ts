import { CSRF_HEADER } from "../../packages/shared/src/index.ts";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

test("files can be created, uploaded, edited, moved, duplicated, downloaded and deleted", async ({
  page,
}) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("dosyalar");
  await page.keyboard.press("Enter");
  const files = page.locator('[data-app-id="everyos.files"]');
  await expect(files.getByTestId("files-app")).toBeVisible();
  // Work in the configured location; the home's standard folders are fixed.
  await files
    .getByTestId("files-sidebar")
    .getByRole("button", { name: "Development files" })
    .click();
  const rows = files.getByTestId("file-row");
  const row = (name: string) => rows.filter({ has: page.getByText(name, { exact: true }) });

  // New folder with inline rename.
  await files.getByRole("button", { name: "Yeni klasör" }).click();
  const rename = files.getByRole("textbox", { name: "Yeniden adlandır" });
  await rename.fill("Arşiv");
  await rename.press("Enter");
  await expect(row("Arşiv")).toBeVisible();

  // Upload through the file picker (streamed, with progress in the status bar).
  await files.locator('input[type="file"]').setInputFiles({
    name: "rapor",
    mimeType: "text/plain",
    buffer: Buffer.from("İlk satır\n"),
  });
  await expect(files.getByTestId("upload-status")).toContainText("Yükleme tamamlandı: 1/1");
  await expect(row("rapor")).toBeVisible();

  // Unassociated extensionless text keeps the built-in editor fallback; Ctrl+S saves.
  await row("rapor").dblclick();
  const editor = page.locator('[data-app-id="everyos.editor"]');
  const text = editor.getByRole("textbox", { name: "rapor içeriği" });
  await expect(text).toHaveValue("İlk satır\n");
  await text.focus();
  await text.evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length),
  );
  await text.pressSequentially("ikinci satır");
  await text.press("Control+s");
  await expect(editor).toContainText("Kaydedildi");
  const saved = (await (await page.request.get("/api/files/text?root=dev&path=rapor")).json()) as {
    content: string;
  };
  expect(saved.content).toBe("İlk satır\nikinci satır");
  await editor.getByRole("button", { name: "Kapat", exact: true }).first().click();

  // Drag the file onto the folder to move it.
  await row("rapor").dragTo(row("Arşiv"));
  await expect(row("rapor")).toHaveCount(0);
  await row("Arşiv").dblclick();
  await expect(files.getByRole("button", { name: "Arşiv" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(row("rapor")).toBeVisible();

  // Context menu: duplicate, properties, download.
  await row("rapor").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Çoğalt" }).click();
  await expect(row("rapor (kopya)")).toBeVisible();
  await row("rapor").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Özellikler" }).click();
  const properties = page.getByRole("dialog", { name: "rapor" });
  await expect(properties).toContainText("/Arşiv/rapor");
  await expect(properties).toContainText("rw-");
  await page.keyboard.press("Escape");
  const download = page.waitForEvent("download");
  await row("rapor").click({ button: "right" });
  await page.getByRole("menuitem", { name: "İndir" }).click();
  expect((await download).suggestedFilename()).toBe("rapor");

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

test("desktop files compress and extract through built-in ZIP controls without reloading", async ({
  page,
}) => {
  await signIn(page);
  const call = (method: string, path: string, body?: unknown) =>
    page.evaluate(
      async ({ method, path, body, header }) => {
        const session = (await (await fetch("/api/auth/session")).json()) as { csrfToken: string };
        const response = await fetch(path, {
          method,
          headers: { "Content-Type": "application/json", [header]: session.csrfToken },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        return { status: response.status, data: text ? (JSON.parse(text) as unknown) : null };
      },
      { method, path, body, header: CSRF_HEADER },
    );
  const suffix = Date.now().toString(36);
  const names = [`zip-one-${suffix}.txt`, `zip-two-${suffix}.txt`];
  const archive = `zip-${suffix}.zip`;
  const folder = `zip-out-${suffix}`;
  const path = (name: string) => `Masaüstü/${name}`;
  const targets = [...names, archive, folder].map(path);
  try {
    for (const name of names)
      expect(
        (
          await call("PUT", "/api/files/text", {
            root: "home",
            path: path(name),
            content: `exact ${name}`,
            etag: null,
          })
        ).status,
      ).toBe(200);
    await page.reload();
    const desktop = page.getByTestId("desktop-surface");
    const origin = await page.evaluate(() => performance.timeOrigin);
    await desktop.getByRole("button", { name: names[0]!, exact: true }).click();
    await desktop
      .getByRole("button", { name: names[1]!, exact: true })
      .click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    await desktop.getByRole("button", { name: names[0]!, exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "ZIP olarak sıkıştır…", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "ZIP oluştur", exact: true });
    await dialog.getByLabel("ZIP dosyasının adı", { exact: true }).fill(archive);
    await dialog.getByRole("button", { name: "ZIP oluştur", exact: true }).click();
    await expect(dialog.getByTestId("transfer")).toHaveAttribute("data-state", "done");
    await dialog.getByRole("button", { name: "Kapat", exact: true }).click();
    await expect(desktop.getByRole("button", { name: archive, exact: true })).toBeVisible();
    await desktop.getByRole("button", { name: archive, exact: true }).dblclick();
    dialog = page.getByRole("dialog", { name: "ZIP arşivini aç", exact: true });
    await expect(dialog.getByRole("list", { name: "Arşiv içeriği" })).toContainText(names[1]!);
    await dialog.getByLabel("Çıkarılacak yeni klasörün adı", { exact: true }).fill(folder);
    await dialog.getByRole("button", { name: "Yeni klasöre çıkar", exact: true }).click();
    await expect(dialog.getByTestId("transfer")).toHaveAttribute("data-state", "done");
    await dialog.getByRole("button", { name: "Kapat", exact: true }).click();
    await expect(desktop.getByRole("button", { name: folder, exact: true })).toBeVisible();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
    const result = await call(
      "GET",
      `/api/files/text?root=home&path=${encodeURIComponent(path(`${folder}/${names[1]}`))}`,
    );
    expect(result.status).toBe(200);
    expect((result.data as { content: string }).content).toBe(`exact ${names[1]}`);
    await expect(page.locator('[data-app-id="everyos.store"]')).toHaveCount(0);
  } finally {
    const existing: string[] = [];
    for (const target of targets)
      if (
        (await call("GET", `/api/files/properties?root=home&path=${encodeURIComponent(target)}`))
          .status === 200
      )
        existing.push(target);
    if (existing.length)
      await call("POST", "/api/files/delete", { root: "home", paths: existing, confirm: true });
  }
});
