import { expect, test } from "@playwright/test";
import { PASSWORD } from "./helpers.ts";

/*
 * EveryOS is often opened by a host address over plain HTTP, where secure-context APIs such as
 * crypto.randomUUID do not exist. Run with EVERYOS_E2E_HTTP_HOST (after foundation's setup test);
 * everything here goes through the browser, which maps that host name to the test server.
 */
test("uploads to the shelf, the desktop and Files work over plain HTTP", async ({ page }) => {
  test.skip(!process.env.EVERYOS_E2E_HTTP_HOST, "Needs EVERYOS_E2E_HTTP_HOST");
  await page.goto("/");
  await page.getByLabel(/Kullanıcı adı|Username/).fill("goktug");
  await page.getByLabel(/^(Parola|Password)$/).fill(PASSWORD);
  await page.getByRole("button", { name: /Giriş yap|Sign in/ }).click();
  await expect(page.getByTestId("desktop")).toBeVisible();
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);

  const file = (name: string) =>
    page.evaluateHandle((fileName) => {
      const data = new DataTransfer();
      data.items.add(
        new File([`uploaded over HTTP: ${fileName}`], fileName, { type: "text/plain" }),
      );
      return data;
    }, name);

  // The pulse shelf.
  await page.getByTestId("pulse-trigger").click();
  await page.getByTestId("pulse-tab-shelf").click();
  await page.dispatchEvent('[data-testid="pulse-dropzone"]', "drop", {
    dataTransfer: await file("raf.txt"),
  });
  await expect(page.getByTestId("pulse-shelf-item").filter({ hasText: "raf.txt" })).toBeVisible();
  await expect(page.getByText("Bilinmeyen bir hata")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The desktop.
  await page.dispatchEvent('[data-testid="desktop-surface"]', "drop", {
    dataTransfer: await file("masaustu.txt"),
  });
  await expect(page.getByRole("button", { name: "masaustu.txt", exact: true })).toBeVisible();

  // A Files window, through its upload button.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("dosyalar");
  await page.keyboard.press("Enter");
  const files = page.locator('[data-app-id="everyos.files"]');
  await files
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "dosyalar.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("uploaded over HTTP"),
    });
  await expect(files.locator('[data-testid="file-row"][data-name="dosyalar.txt"]')).toBeVisible();
  await expect(page.getByText("Bilinmeyen bir hata")).toHaveCount(0);
});
