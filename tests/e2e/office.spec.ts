import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CSRF_HEADER } from "../../packages/shared/src/index.ts";
import { blankWorkbook, wordDocument } from "../../packages/office-core/src/container.ts";
import { signIn } from "./helpers.ts";
import { ZipReader, Uint8ArrayReader, TextWriter } from "@zip.js/zip.js/index-native.js";

async function payload(page: Page, path: string) {
  const result = await page.evaluate(async (path) => {
    const response = await fetch(`/api/files/download?root=home&path=${encodeURIComponent(path)}`);
    return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
  }, path);
  expect(result.status).toBe(200);
  return new Uint8Array(result.bytes);
}
async function xmlPart(bytes: Uint8Array, name: string) {
  const zip = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  try {
    const part = (await zip.getEntries()).find((entry) => entry.filename === name);
    if (!part || part.directory) throw new Error(`Missing ${name}`);
    return await part.getData(new TextWriter());
  } finally {
    await zip.close();
  }
}

test.setTimeout(180_000);
test.use({ actionTimeout: 15_000 });
async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body, header }) => {
      const session = (await (await fetch("/api/auth/session")).json()) as { csrfToken: string };
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json", [header]: session.csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, text: await response.text() };
    },
    { method, path, body, header: CSRF_HEADER },
  );
}

test("official office apps open modern and legacy files through native file handoff", async ({
  page,
}, testInfo) => {
  await signIn(page);
  const files: Array<[string, Uint8Array]> = [
    [
      "office-modern.docx",
      await wordDocument("<w:p><w:r><w:t>Modern Word fixture</w:t></w:r></w:p>"),
    ],
    ["office-modern.xlsx", await blankWorkbook("Modern")],
    ["office-data.csv", new TextEncoder().encode('21,2\r\nİstanbul,"a,b"\r\n=1+2,00123\r\n')],
    [
      "office-old.doc",
      new Uint8Array(readFileSync(resolve("packages/office-core/test/fixtures/legacy.doc"))),
    ],
    [
      "office-old.xls",
      new Uint8Array(readFileSync(resolve("packages/office-core/test/fixtures/legacy.xls"))),
    ],
  ];
  for (const [name, bytes] of files) {
    const result = await page.evaluate(
      async ({ name, data, header }) => {
        const session = (await (await fetch("/api/auth/session")).json()) as { csrfToken: string };
        return (
          await fetch(
            `/api/files/upload?root=home&path=Masaüstü&name=${encodeURIComponent(name)}`,
            {
              method: "POST",
              headers: { [header]: session.csrfToken },
              body: new Uint8Array(data),
            },
          )
        ).status;
      },
      { name, data: [...bytes], header: CSRF_HEADER },
    );
    expect(result).toBe(201);
  }
  await page.reload();
  const desktop = page.getByTestId("desktop-surface");
  for (const [name, title] of [
    ["office-modern.docx", "Word Editor"],
    ["office-modern.xlsx", "Spreadsheet Editor"],
    ["office-data.csv", "Spreadsheet Editor"],
  ]) {
    const item = desktop.getByRole("button", { name: name!, exact: true });
    await item.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "İndir", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await item.dblclick();
    const store = page.locator('[data-app-id="everyos.store"]');
    await expect(store).toContainText(title!);
    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Kur", exact: true }),
    ).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Kapat", exact: true }).click();
    await store.getByRole("button", { name: "Kapat", exact: true }).first().click();
  }
  for (const slug of ["word", "excel"]) {
    const response = await api(page, "POST", "/api/desktop-apps/installed", {
      registryId: "official",
      appId: `dev.everyos.${slug}`,
      approve: ["files:pick", "files:save"],
    });
    expect(response.status, response.text).toBe(201);
  }
  await page.reload();
  const initialNavigation = await page.evaluate(() => performance.timeOrigin);
  for (const [name] of files) {
    const csv = name.endsWith(".csv");
    const slug = name.endsWith("doc") || name.endsWith("docx") ? "word" : "excel";
    await desktop.getByRole("button", { name, exact: true }).dblclick();
    const window = page.locator(`[data-app-id="everyos.desktop.dev.everyos.${slug}"]`);
    await expect(window.getByTestId("desktop-app-frame")).toHaveAttribute("data-phase", "ready");
    const frame = window.frameLocator('[data-testid="desktop-app-frame"]');
    await expect(
      frame.getByTestId("office-actions").getByRole("button", { name: "Kaydet", exact: true }),
    ).toBeEnabled({ timeout: 60_000 });
    await expect(frame.locator(".office-status")).toHaveText("Hazır");
    if (csv)
      await expect(frame.locator(".office-notice")).toContainText(
        "CSV yalnızca ilk sayfanın değerlerini kaydeder",
      );
    if (name.includes("old"))
      await expect(frame.locator(".office-notice")).toContainText("özgün dosya korunur");
    if (slug === "word") {
      await frame
        .locator("canvas")
        .first()
        .click({ position: { x: 100, y: 85 } });
      await page.keyboard.press("End");
      await page.keyboard.type(" browser-edit-proof");
    } else {
      await frame.getByTestId("xlsx-scroll").press("F2");
      const cell = frame.getByTestId("xlsx-cell-editor");
      await cell.fill("40");
      await cell.press("Enter");
    }
    await expect(frame.locator(".office-status")).toHaveText("Kaydedilmemiş değişiklikler");
    // An unsaved document cannot be silently closed or replaced.
    await window.getByRole("button", { name: "Kapat", exact: true }).first().click();
    if (name === "office-modern.docx") {
      await expect(page.getByRole("alertdialog")).toBeVisible();
      // A human decision may take longer than the host's ten-second close RPC deadline.
      await page.waitForTimeout(10_500);
      await expect(window).toBeVisible();
    }
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Vazgeç", exact: true })
      .click();
    await expect(window).toBeVisible();
    await frame
      .getByTestId("office-actions")
      .getByRole("button", { name: "Kaydet", exact: true })
      .click();
    const picker = page.getByTestId("desktop-app-file-picker");
    const legacy = name.includes("old");
    const savedName = legacy ? name + "x" : name;
    // Native file handoff grants read access; the user chooses where to save the edited copy.
    await expect(picker.getByRole("textbox", { name: "Ad", exact: true })).toHaveValue(savedName);
    await picker.getByRole("button", { name: "Kaydet", exact: true }).click();
    await expect(frame.locator(".office-status")).toHaveText("Hazır");
    const saved = await payload(page, "Belgeler/" + savedName);
    if (slug === "word")
      expect(await xmlPart(saved, "word/document.xml")).toContain("browser-edit-proof");
    else if (csv)
      expect(new TextDecoder().decode(saved)).toBe('40,2\r\nİstanbul,"a,b"\r\n=1+2,00123\r\n');
    else expect(await xmlPart(saved, "xl/worksheets/sheet1.xml")).toContain(">40<");
    if (legacy) {
      expect(await payload(page, "Masaüstü/" + name)).toEqual(
        files.find(([entry]) => entry === name)![1],
      );
      await expect(frame.locator(".office-notice")).toHaveCount(0);
    }
    if (!legacy) {
      if (slug === "word") {
        await frame
          .locator("canvas")
          .first()
          .click({ position: { x: 100, y: 85 } });
        await page.keyboard.type(" second-write-proof");
      } else {
        await frame.getByTestId("xlsx-scroll").press("ArrowUp");
        await frame.getByTestId("xlsx-scroll").press("F2");
        await frame.getByTestId("xlsx-cell-editor").fill("41");
        await frame.getByTestId("xlsx-cell-editor").press("Enter");
      }
      await expect(frame.locator(".office-status")).toHaveText("Kaydedilmemiş değişiklikler");
      const mod = await frame
        .locator("html")
        .evaluate(() => (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control"));
      await page.keyboard.press(mod + "+s");
      await expect(frame.locator(".office-status")).toHaveText("Hazır");
      await expect(picker).toHaveCount(0);
      const rewritten = await payload(page, "Belgeler/" + savedName);
      if (csv)
        expect(new TextDecoder().decode(rewritten)).toBe(
          '41,2\r\nİstanbul,"a,b"\r\n=1+2,00123\r\n',
        );
      else
        expect(
          await xmlPart(
            rewritten,
            slug === "word" ? "word/document.xml" : "xl/worksheets/sheet1.xml",
          ),
        ).toContain(slug === "word" ? "second-write-proof" : ">41<");
      expect(await payload(page, "Masaüstü/" + name)).toEqual(
        files.find(([entry]) => entry === name)![1],
      );
      if (csv) {
        await frame
          .getByTestId("office-actions")
          .getByRole("button", { name: "Farklı kaydet…", exact: true })
          .click();
        await picker.getByRole("textbox", { name: "Ad", exact: true }).fill("office-data.xlsx");
        await picker.getByRole("button", { name: "Kaydet", exact: true }).click();
        await expect(frame.locator(".office-status")).toHaveText("Hazır");
        await expect(frame.locator(".office-notice")).toHaveCount(0);
        expect(
          await xmlPart(
            await payload(page, "Belgeler/office-data.xlsx"),
            "xl/worksheets/sheet1.xml",
          ),
        ).toContain(">41<");
      }
    }
    await page.screenshot({ path: testInfo.outputPath(name + ".png") });
    await window.getByRole("button", { name: "Kapat", exact: true }).first().click();
  }
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(initialNavigation);
});
