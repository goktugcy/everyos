import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { capabilityInfo, type AppCapability } from "../../packages/app-manifest/src/index.ts";
import { CSRF_HEADER } from "../../packages/shared/src/index.ts";
import { signIn } from "./helpers.ts";

/*
 * EveryOS's official apps (official-apps/*), built and signed into the fixture's official registry,
 * installed and used in a real browser on a real EveryOS: in their sandbox, through the bridge.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../../official-apps");
const OFFICIAL = readdirSync(root)
  .filter((slug) => existsSync(join(root, slug, "manifest.json")))
  .sort()
  .map((slug) => {
    const manifest = JSON.parse(readFileSync(join(root, slug, "manifest.json"), "utf8")) as {
      id: string;
      permissions: AppCapability[];
    };
    const tr = JSON.parse(readFileSync(join(root, slug, "public/locales/tr.json"), "utf8")) as {
      app: { name: string };
    };
    return { slug, id: manifest.id, permissions: manifest.permissions, name: tr.app.name };
  });

/** An API call made by the signed-in page itself (so it also works over EVERYOS_E2E_HTTP_HOST). */
function api(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
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

/** Installs through the API, then reloads so the desktop lists the app (the store UI does both). */
async function install(page: Page, app: (typeof OFFICIAL)[number]) {
  const approve = app.permissions.filter(
    (capability) => capabilityInfo(capability).risk !== "standard",
  );
  const response = await api(page, "POST", "/api/desktop-apps/installed", {
    registryId: "official",
    appId: app.id,
    approve,
  });
  expect(response.status, response.text).toBe(201);
  await page.reload();
  await expect(page.getByTestId("desktop")).toBeVisible();
}

async function open(page: Page, name: string, appId: string) {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill(name);
  await page.getByRole("option").filter({ hasText: name }).first().click();
  const window = page.locator(`[data-app-id="everyos.desktop.${appId}"]`);
  await expect(window).toBeVisible();
  await expect(window.getByTestId("desktop-app-frame")).toHaveAttribute("data-phase", "ready");
  return { window, frame: window.frameLocator('[data-testid="desktop-app-frame"]') };
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await signIn(page);
  expect((await api(page, "POST", "/api/desktop-apps/registries/official/sync", {})).status).toBe(
    200,
  );
});

test("every official app installs, starts in its sandbox and shows no error", async ({ page }) => {
  test.setTimeout(60_000 + OFFICIAL.length * 20_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const app of OFFICIAL) {
    await test.step(app.slug, async () => {
      await install(page, app);
      try {
        const { window, frame } = await open(page, app.name, app.id);
        await expect(frame.locator("#app > *").first()).toBeVisible();
        await expect(frame.getByTestId("error-state")).toHaveCount(0);
        await expect(frame.locator("body")).not.toContainText("EveryOS did not connect");
        await window.getByRole("button", { name: "Kapat" }).first().click();
        await expect(window).toHaveCount(0);
      } finally {
        await api(page, "DELETE", `/api/desktop-apps/installed/${app.id}`, { confirm: true });
      }
    });
  }
  expect(errors).toEqual([]);
});

test.describe("Notes", () => {
  const notes = OFFICIAL.find((app) => app.slug === "notes")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${notes.id}`, { confirm: true });
  });

  const editor = (frame: FrameLocator) => frame.getByRole("textbox", { name: "Not metni" });

  test("writes Markdown, keeps it across reloads and adds notes from its widget", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await install(page, notes);

    let { window, frame } = await open(page, notes.name, notes.id);
    await expect(frame.getByText("Henüz not yok")).toBeVisible();
    await frame.getByRole("button", { name: "Yeni not" }).first().click();
    await editor(frame).fill(
      "# Alışveriş\n\n- [ ] süt\n- **ekmek**\n\n<img src=x onerror=alert(1)>",
    );
    // Rendered in the sandbox, raw HTML shown as text.
    const preview = frame.locator(".notes-preview");
    await expect(preview.locator("h1")).toHaveText("Alışveriş");
    await expect(preview.locator("input[type=checkbox]")).toBeDisabled();
    await expect(preview.locator("strong")).toHaveText("ekmek");
    await expect(preview.locator("img")).toHaveCount(0);
    await expect(preview).toContainText("<img src=x onerror=alert(1)>");
    await expect(frame.getByRole("status").filter({ hasText: "Kaydedildi" })).toBeVisible();
    // The window is titled after the note.
    await expect(window).toContainText("Alışveriş");

    // After a reload, the window comes back at the same note.
    await page.reload();
    await expect(page.getByTestId("desktop")).toBeVisible();
    window = page.locator(`[data-app-id="everyos.desktop.${notes.id}"]`);
    await expect(window).toBeVisible();
    frame = window.frameLocator('[data-testid="desktop-app-frame"]');
    await expect(editor(frame)).toHaveValue(/# Alışveriş/);

    // The Quick note widget adds a note the app then lists, and opens it there.
    const sidebar = page.getByTestId("widget-sidebar");
    if (!(await sidebar.isVisible())) await page.getByTestId("widget-sidebar-toggle").click();
    await sidebar.getByRole("button", { name: "Widget ekle…" }).first().click();
    const gallery = page.getByRole("dialog", { name: "Widget galerisi" });
    await gallery.getByRole("tab", { name: "Uygulamalar", exact: true }).click();
    await gallery.getByRole("button", { name: "Ekle: Hızlı not" }).click();
    await page.keyboard.press("Escape");
    const widget = sidebar.locator(`[data-testid="widget"][data-widget="${notes.id}#quick"]`);
    await expect(widget).toBeVisible();
    const quick = widget.frameLocator('[data-testid="desktop-app-frame"]');
    await quick.getByRole("textbox", { name: "Hızlı bir not yazın…" }).fill("Tesisatçıyı ara");
    await quick.getByRole("button", { name: "Not ekle" }).click();
    await expect(quick.getByRole("status")).toHaveText("Not eklendi");
    await quick.getByRole("button", { name: "Tesisatçıyı ara" }).click();
    await expect(editor(frame)).toHaveValue("Tesisatçıyı ara");
    await expect(frame.locator(".notes-row-title")).toHaveText(["Tesisatçıyı ara", "Alışveriş"]);
  });
});

test.describe("Regex Tester", () => {
  const regex = OFFICIAL.find((app) => app.slug === "regex")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${regex.id}`, { confirm: true });
  });

  test("matches in its worker and stops runaway expressions", async ({ page }) => {
    test.setTimeout(60_000);
    await install(page, regex);
    const { frame } = await open(page, regex.name, regex.id);
    const pattern = frame.getByRole("textbox", { name: "Düzenli ifade" });
    const text = frame.getByRole("textbox", { name: "Test metni" });
    await pattern.fill(String.raw`(\d+)-(\d+)`);
    await text.fill("10-20 ve 3-4");
    await expect(frame.locator(".rx-highlight mark")).toHaveText(["10-20", "3-4"]);
    // Catastrophic backtracking: the worker is stopped, the window stays responsive.
    await pattern.fill("(a+)+$");
    await text.fill(`${"a".repeat(40)}!`);
    await expect(frame.locator(".rx-status")).toContainText("Durduruldu", { timeout: 10_000 });
    await pattern.fill("a");
    await expect(frame.locator(".rx-status")).toContainText("40 eşleşme");
  });
});
