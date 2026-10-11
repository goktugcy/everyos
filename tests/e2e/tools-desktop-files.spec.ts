import { expect, test } from "@playwright/test";
import {
  CSRF_HEADER,
  type FileRootsResponse,
  type TrashListing,
} from "../../packages/shared/src/index.ts";
import { preferences, signIn } from "./helpers.ts";

test("selected desktop files copy and cut together into Files folders", async ({ page }) => {
  const session = await signIn(page);
  const headers = { [CSRF_HEADER]: session.csrfToken };
  await page.goto("about:blank");
  const roots = (await (await page.request.get("/api/files/roots")).json()) as FileRootsResponse;
  const home = roots.roots.find((root) => root.kind === "home")!;
  const from = home.folders!.desktop!;
  const documents = home.folders!.documents!;
  const names = ["clipboard-a.txt", "clipboard-b.txt"] as const;
  for (const name of names)
    expect(
      (
        await page.request.put("/api/files/text", {
          headers,
          data: {
            root: "home",
            path: `${from}/${name}`,
            content: `content of ${name}`,
            etag: null,
          },
        })
      ).status(),
    ).toBe(200);
  for (const name of ["clipboard-copy", "clipboard-cut"])
    expect(
      (
        await page.request.post("/api/files/mkdir", {
          headers,
          data: { root: "home", path: documents, name },
        })
      ).status(),
    ).toBe(201);
  await page.goto("/");
  const surface = page.getByTestId("desktop-surface");
  const a = surface.getByRole("button", { name: names[0], exact: true });
  const b = surface.getByRole("button", { name: names[1], exact: true });
  await a.click();
  await b.click({ modifiers: ["ControlOrMeta"] });
  await b.press("Control+c");
  const pasteInto = async (name: string) => {
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("dosyalar");
    await page.getByRole("option", { name: "Dosyalar", exact: true }).click();
    const files = page.locator('[data-app-id="everyos.files"]');
    await files
      .getByTestId("files-sidebar")
      .getByRole("button", { name: documents, exact: true })
      .click();
    await files.getByTestId("file-row").filter({ hasText: name }).dblclick();
    await files.getByTestId("file-list").press("Control+v");
    for (const file of names)
      await expect(files.getByTestId("file-row").filter({ hasText: file })).toBeVisible();
    await files.getByRole("button", { name: "Kapat", exact: true }).first().click();
  };
  await pasteInto("clipboard-copy");
  await expect(a).toBeVisible();
  await expect(b).toBeVisible();
  await b.focus();
  await b.press("Control+x");
  await pasteInto("clipboard-cut");
  await expect(a).toHaveCount(0);
  await expect(b).toHaveCount(0);
  // Pasting into the desktop background executes once, with the complete Files selection.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("dosyalar");
  await page.getByRole("option", { name: "Dosyalar", exact: true }).click();
  const files = page.locator('[data-app-id="everyos.files"]');
  await files
    .getByTestId("files-sidebar")
    .getByRole("button", { name: documents, exact: true })
    .click();
  await files.getByTestId("file-row").filter({ hasText: "clipboard-copy" }).dblclick();
  for (const name of names)
    await expect(files.getByTestId("file-row").filter({ hasText: name })).toBeVisible();
  for (const mode of ["Simgeler", "Liste"]) {
    await files.getByRole("button", { name: mode, exact: true }).click();
    const list = files.getByTestId("file-list");
    const bounds = (await list.boundingBox())!;
    const first = (await files
      .getByTestId("file-row")
      .filter({ hasText: names[0] })
      .boundingBox())!;
    const second = (await files
      .getByTestId("file-row")
      .filter({ hasText: names[1] })
      .boundingBox())!;
    await page.mouse.move(
      bounds.x + bounds.width - 8,
      Math.max(first.y + first.height, second.y + second.height) + 12,
    );
    await page.mouse.down();
    await page.mouse.move(Math.min(first.x, second.x) + 2, Math.min(first.y, second.y) + 2, {
      steps: 5,
    });
    await expect(files.getByTestId("files-selection-area")).toBeVisible();
    await page.mouse.up();
    await expect(files.getByTestId("files-selection-area")).toHaveCount(0);
    await expect(files.locator('[data-testid="file-row"][aria-selected="true"]')).toHaveCount(2);
    if (mode === "Simgeler") await list.press("Escape");
  }
  await files.getByTestId("file-list").press("Control+c");
  await files.getByRole("button", { name: "Kapat", exact: true }).first().click();
  let transfers = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/files/copy")
      transfers++;
  });
  const copied = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/files/copy",
  );
  await surface.press("Control+v");
  expect((await copied).status()).toBe(204);
  await expect(a).toBeVisible();
  await expect(b).toBeVisible();
  await expect(surface.getByRole("alert")).toHaveCount(0);
  expect(transfers).toBe(1);
  for (const folder of ["clipboard-copy", "clipboard-cut"])
    for (const name of names) {
      const result = await page.request.get(
        `/api/files/text?${new URLSearchParams({ root: "home", path: `${documents}/${folder}/${name}` }).toString()}`,
      );
      expect(((await result.json()) as { content: string }).content).toBe(`content of ${name}`);
    }
  expect(
    (
      await page.request.post("/api/files/delete", {
        headers,
        data: {
          root: "home",
          paths: [
            ...names.map((name) => `${from}/${name}`),
            `${documents}/clipboard-copy`,
            `${documents}/clipboard-cut`,
          ],
          confirm: true,
        },
      })
    ).status(),
  ).toBe(204);
});

test("desktop multi-selection, marquee, group movement and recoverable trash work with real files", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const session = await signIn(page);
  const headers = { [CSRF_HEADER]: session.csrfToken };
  // Seed preferences without a live desktop autosaving an older file layout over them.
  await page.goto("about:blank");
  const roots = (await (await page.request.get("/api/files/roots")).json()) as FileRootsResponse;
  const home = roots.roots.find((root) => root.kind === "home")!;
  const desktopPath = home.folders!.desktop!;
  const names = ["selection-a.txt", "selection-b.txt", "selection-c.txt"] as const;
  for (const name of names)
    expect(
      (
        await page.request.put("/api/files/text", {
          headers,
          data: {
            root: "home",
            path: `${desktopPath}/${name}`,
            content: `real content ${name}`,
            etag: null,
          },
        })
      ).status(),
    ).toBe(200);
  expect(
    (
      await page.request.put("/api/preferences/desktop", {
        headers,
        data: {
          version: 1,
          desktops: [{ id: "selection-desktop", name: "Ana", wallpaper: null }],
          items: [],
          files: names.map((name, index) => ({
            name,
            cell: index < 2 ? { col: 3, row: index } : { col: 4, row: 0 },
          })),
        },
      })
    ).status(),
  ).toBe(204);
  await page.goto("/");
  const surface = page.getByTestId("desktop-surface");
  const icon = (name: string) => surface.getByRole("button", { name, exact: true });
  const a = icon(names[0]);
  const b = icon(names[1]);
  const c = icon(names[2]);
  await expect(a).toBeVisible();
  await a.click();
  await b.click({ modifiers: ["ControlOrMeta"] });
  await expect(a).toHaveAttribute("aria-pressed", "true");
  await expect(b).toHaveAttribute("aria-pressed", "true");
  await a.click({ modifiers: ["ControlOrMeta"] });
  await expect(a).toHaveAttribute("aria-pressed", "false");
  await c.click({ modifiers: ["Shift"] });
  await expect(surface.locator('[data-desktop-item][aria-pressed="true"]')).toHaveCount(3);
  await c.press("Control+a");
  await expect(surface.locator('[data-desktop-item][aria-pressed="true"]')).toHaveCount(
    await surface.locator("[data-desktop-item]").count(),
  );
  await c.press("Escape");
  await expect(surface.locator('[aria-pressed="true"]')).toHaveCount(0);

  // Draw backwards from empty space around the two icons; releasing removes the rectangle.
  const ar = (await a.boundingBox())!;
  const br = (await b.boundingBox())!;
  await page.mouse.move(br.x + br.width + 3, br.y + br.height + 3);
  await page.mouse.down();
  await page.mouse.move(ar.x - 3, ar.y - 3, { steps: 8 });
  await expect(surface.getByTestId("desktop-selection-area")).toBeVisible();
  await page.mouse.up();
  await expect(surface.getByTestId("desktop-selection-area")).toHaveCount(0);
  await expect(a).toHaveAttribute("aria-pressed", "true");
  await expect(b).toHaveAttribute("aria-pressed", "true");
  await expect(c).toHaveAttribute("aria-pressed", "false");

  // A native file drag keeps the selected pair together and saves both positions.
  const bounds = (await surface.boundingBox())!;
  await a.dragTo(surface, {
    targetPosition: { x: ar.x + 210 - bounds.x, y: ar.y + 20 - bounds.y },
  });
  await expect.poll(async () => (await a.boundingBox())!.x).toBeGreaterThan(ar.x + 100);
  await expect.poll(async () => (await b.boundingBox())!.x).toBeGreaterThan(br.x + 100);
  await expect
    .poll(async () =>
      (await preferences(page)).desktop?.files
        .filter((entry) => names.slice(0, 2).some((name) => name === entry.name))
        .map((entry) => entry.cell.col),
    )
    .toEqual([5, 5]);

  await surface.focus();
  await surface.press("Delete");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("2 öğe");
  await confirm.getByRole("button", { name: "Vazgeç" }).click();
  await expect(a).toBeVisible();
  await surface.press("Delete");
  await confirm.getByRole("button", { name: "Çöp kutusuna taşı" }).click();
  await expect(a).toHaveCount(0);
  await expect(b).toHaveCount(0);
  await expect(c).toBeVisible();

  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("çöp");
  await page.getByRole("option", { name: "Çöp Kutusu", exact: true }).click();
  const trash = page.locator('[data-app-id="everyos.trash"]');
  await trash.getByLabel(`${names[0]} öğesini seç`).check();
  await trash.getByLabel(`${names[1]} öğesini seç`).check();
  await trash.getByRole("button", { name: "Geri yükle", exact: true }).click();
  await expect(a).toBeAttached();
  await expect(b).toBeAttached();
  await expect(trash.getByLabel(`${names[0]} öğesini seç`)).toHaveCount(0);

  // Permanent deletion remains a separate, cancellable confirmation in the trash window.
  expect(
    (
      await page.request.post("/api/files/delete", {
        headers,
        data: { root: "home", paths: [`${desktopPath}/${names[0]}`], confirm: true },
      })
    ).status(),
  ).toBe(204);
  await trash.getByRole("button", { name: "Yenile", exact: true }).click();
  await trash.getByLabel(`${names[0]} öğesini seç`).check();
  await trash.getByRole("button", { name: "Kalıcı olarak sil", exact: true }).click();
  await confirm.getByRole("button", { name: "Vazgeç" }).click();
  await expect(trash.getByLabel(`${names[0]} öğesini seç`)).toBeVisible();
  await trash.getByRole("button", { name: "Kalıcı olarak sil", exact: true }).click();
  await confirm.getByRole("button", { name: "Kalıcı olarak sil", exact: true }).click();
  await expect(trash.getByLabel(`${names[0]} öğesini seç`)).toHaveCount(0);
  const listing = (await (await page.request.get("/api/files/trash")).json()) as TrashListing;
  expect(listing.entries.some((entry) => entry.name === names[0])).toBe(false);
  expect(
    (
      await page.request.get(
        `/api/files/text?${new URLSearchParams({ root: "home", path: `${desktopPath}/${names[0]}` }).toString()}`,
      )
    ).status(),
  ).toBe(404);
  await page.screenshot({
    path: test.info().outputPath("desktop-trash.png"),
    animations: "disabled",
  });
  expect(
    (
      await page.request.post("/api/files/delete", {
        headers,
        data: {
          root: "home",
          paths: names.slice(1).map((name) => `${desktopPath}/${name}`),
          confirm: true,
        },
      })
    ).status(),
  ).toBe(204);
});
