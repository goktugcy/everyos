import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { capabilityInfo, type AppCapability } from "../../packages/app-manifest/src/index.ts";
import { CSRF_HEADER } from "../../packages/shared/src/index.ts";
import { makePdf } from "../../official-apps/pdf/test/make-pdf.ts";
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

test.describe("Diff Viewer", () => {
  const diff = OFFICIAL.find((app) => app.slug === "diff")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${diff.id}`, { confirm: true });
  });

  test("compares side by side and inline, and moves between changes", async ({ page }) => {
    test.setTimeout(60_000);
    await install(page, diff);
    const { frame } = await open(page, diff.name, diff.id);
    const original = frame.getByRole("textbox", { name: "Özgün" });
    const changed = frame.getByRole("textbox", { name: "Değişmiş" });
    await original.fill("bir\niki\nüç\ndört\n");
    await changed.fill("bir\nİKİ\nüç\ndört\nbeş\n");
    await expect(frame.locator(".diff-position")).toHaveText("2 değişiklik");
    await expect(frame.locator(".diff-added")).toHaveText("+2");
    await expect(frame.locator(".diff-removed")).toHaveText("−1");
    // Two aligned editors next to each other, with the changed words marked.
    const [left, right] = await Promise.all([
      frame.locator(".cm-merge-a").boundingBox(),
      frame.locator(".cm-merge-b").boundingBox(),
    ]);
    expect(left!.width).toBeGreaterThan(200);
    expect(right!.x).toBeGreaterThanOrEqual(left!.x + left!.width - 1);
    await expect(frame.locator(".cm-merge-b .cm-changedText").first()).toHaveText("İKİ");
    await frame.getByRole("button", { name: "Sonraki değişiklik (F7)" }).click();
    await expect(frame.locator(".diff-position")).toHaveText("1 / 2");
    await page.keyboard.press("F7");
    await expect(frame.locator(".diff-position")).toHaveText("2 / 2");
    await frame.getByRole("tab", { name: "Satır içi" }).click();
    // The removed line is shown above its replacement (pure insertions get an empty widget).
    await expect(frame.locator(".cm-deletedChunk", { hasText: "iki" })).toHaveCount(1);
    await expect(frame.locator(".cm-editor")).toHaveCount(1);
  });
});

test.describe("Code Editor", () => {
  const code = OFFICIAL.find((app) => app.slug === "code")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${code.id}`, { confirm: true });
  });

  test("opens a workspace folder the person picks, edits and saves a file in it", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await install(page, code);
    for (const [path, name] of [
      ["Belgeler", "kod-projesi"],
      ["Belgeler/kod-projesi", "src"],
    ])
      expect(
        (await api(page, "POST", "/api/files/mkdir", { root: "home", path, name })).status,
      ).toBe(201);
    expect(
      await page.evaluate(async (header) => {
        const session = (await (await fetch("/api/auth/session")).json()) as { csrfToken: string };
        const response = await fetch(
          "/api/files/upload?root=home&path=Belgeler/kod-projesi/src&name=main.ts",
          {
            method: "POST",
            headers: { [header]: session.csrfToken },
            body: "export const answer = 42;\n",
          },
        );
        return response.status;
      }, CSRF_HEADER),
    ).toBe(201);

    const { window, frame } = await open(page, code.name, code.id);
    await frame.getByRole("button", { name: "Klasör aç…" }).first().click();
    const picker = window.getByTestId("desktop-app-file-picker");
    await expect(picker).toContainText("Klasör seç");
    await picker.getByRole("option", { name: "kod-projesi" }).click();
    await picker.getByRole("button", { name: "Bu klasörü seç" }).click();

    await frame.getByRole("treeitem", { name: "src" }).click();
    await frame.getByRole("treeitem", { name: "main.ts" }).click();
    await expect(frame.getByRole("tab", { name: "main.ts" })).toBeVisible();
    const content = frame.getByRole("textbox", { name: "main.ts içeriği" });
    await expect(content).toContainText("export const answer = 42;");
    // Highlighted as TypeScript, with the minimap drawn next to the text.
    await expect(content.locator("span").first()).toBeVisible();
    const minimap = frame.locator(".cm-minimap-gutter canvas");
    await expect(minimap).toBeVisible();
    expect((await minimap.boundingBox())!.width).toBeGreaterThan(20);

    await content.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("// e2e");
    // Screen readers hear the unsaved mark as words.
    await expect(
      frame.getByRole("tab", { name: "Kaydedilmemiş değişiklikler main.ts" }),
    ).toBeVisible();
    await page.keyboard.press("ControlOrMeta+s");
    await expect(frame.getByRole("tab", { name: "main.ts", exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const response = await fetch(
            "/api/files/text?root=home&path=Belgeler/kod-projesi/src/main.ts",
          );
          return ((await response.json()) as { content: string }).content;
        }),
      )
      .toBe("export const answer = 42;\n// e2e");
  });
});

test.describe("PDF Viewer", () => {
  const pdf = OFFICIAL.find((app) => app.slug === "pdf")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${pdf.id}`, { confirm: true });
  });

  test("renders, searches, navigates, remembers the place and prints a document", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await install(page, pdf);
    const bytes = makePdf({
      // Five pages: the third can scroll to the top (the current page is the first one in view).
      pages: [
        ["Hello EveryOS"],
        ["Second page", "search target"],
        ["Third page"],
        ["Four"],
        ["Five"],
      ],
      outline: [
        { title: "Chapter 1", page: 1 },
        { title: "Chapter 3", page: 3 },
      ],
    });
    expect(
      await page.evaluate(
        async ({ header, data }) => {
          const session = (await (await fetch("/api/auth/session")).json()) as {
            csrfToken: string;
          };
          const response = await fetch(
            "/api/files/upload?root=home&path=Belgeler&name=kilavuz.pdf",
            {
              method: "POST",
              headers: { [header]: session.csrfToken },
              body: new Uint8Array(data),
            },
          );
          return response.status;
        },
        { header: CSRF_HEADER, data: [...bytes] },
      ),
    ).toBe(201);

    const opened = await open(page, pdf.name, pdf.id);
    const window = opened.window;
    let frame = opened.frame;
    await frame.getByRole("button", { name: "PDF aç…" }).first().click();
    const picker = window.getByTestId("desktop-app-file-picker");
    await picker.getByRole("option", { name: "kilavuz.pdf" }).click();
    await picker.getByRole("button", { name: "Aç" }).click();

    // pdf.js in its worker: drawn pages with a selectable text layer, and thumbnails.
    await expect(frame.locator(".pdf-page-count")).toHaveText("/ 5");
    await expect(frame.locator(".textLayer").first()).toContainText("Hello EveryOS");
    const firstPage = frame.locator(".pdfViewer .page canvas").first();
    await expect(firstPage).toBeVisible();
    expect((await firstPage.boundingBox())!.width).toBeGreaterThan(200);
    await expect(frame.locator(".pdf-thumb-canvas")).toHaveCount(5);
    await expect(frame.locator(".pdf-thumb-canvas").first()).toHaveAttribute("height", "155");

    await frame.getByRole("button", { name: "Sonraki sayfa" }).click();
    await expect(frame.getByRole("textbox", { name: "Sayfa numarası" })).toHaveValue("2");

    await frame
      .getByRole("button", { name: "Belgede bul (Ctrl+F)" })
      .or(frame.getByRole("button", { name: "Belgede bul (⌘F)" }))
      .click();
    await frame.getByRole("textbox", { name: "Bul" }).fill("target");
    await expect(frame.locator(".pdf-find-status")).toHaveText("1 / 1 eşleşme");
    await expect(frame.locator(".textLayer .highlight").first()).toBeVisible();
    await frame.getByRole("button", { name: "Aramayı kapat" }).click();

    await frame.getByRole("tab", { name: "Ana hatlar" }).click();
    await frame.getByRole("button", { name: "Chapter 3" }).click();
    await expect(frame.getByRole("textbox", { name: "Sayfa numarası" })).toHaveValue("3");

    await frame.getByRole("button", { name: "Sağa döndür" }).click();
    const third = frame.locator('.pdfViewer .page[data-page-number="3"]');
    await expect
      .poll(async () => {
        const box = await third.boundingBox();
        return box ? box.width > box.height : false;
      })
      .toBe(true);
    await frame.getByRole("button", { name: "Bu sayfaya yer imi ekle" }).click();
    await frame.getByRole("tab", { name: "Yer imleri" }).click();
    await expect(frame.locator(".pdf-bookmark-label")).toHaveText(["Sayfa 3"]);

    // Printing: every page is drawn for the print dialog (the dialog itself is the browser's).
    const app = page.frames().find((candidate) => candidate.url().includes("/app-runtime/"))!;
    await app.evaluate(() => {
      // `globalThis`: the page's window (`window` here is the app window's locator).
      const target = globalThis as unknown as { print: () => void; printed: number };
      target.print = () => {
        target.printed = document.querySelectorAll(".pdf-print img").length;
      };
    });
    await frame.getByRole("button", { name: /^Yazdır/ }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { printed?: number }).printed))
      .toBe(5);

    // Reopened from the recent list: the same page, rotation and bookmark.
    await window.getByRole("button", { name: "Kapat" }).first().click();
    ({ frame } = await open(page, pdf.name, pdf.id));
    await frame.getByRole("button", { name: /kilavuz\.pdf/ }).click();
    await expect(frame.getByRole("textbox", { name: "Sayfa numarası" })).toHaveValue("3");
    await frame.getByRole("tab", { name: "Yer imleri" }).click();
    await expect(frame.locator(".pdf-bookmark-label")).toHaveText(["Sayfa 3"]);
    await expect
      .poll(async () => {
        const box = await frame.locator('.pdfViewer .page[data-page-number="3"]').boundingBox();
        return box ? box.width > box.height : false;
      })
      .toBe(true);
  });
});

test.describe("Calendar", () => {
  const calendar = OFFICIAL.find((app) => app.slug === "calendar")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${calendar.id}`, { confirm: true });
  });

  test("adds a repeating event and shows it in the month and week views", async ({ page }) => {
    test.setTimeout(60_000);
    await install(page, calendar);
    const { frame } = await open(page, calendar.name, calendar.id);
    await frame.getByRole("button", { name: "Yeni etkinlik" }).first().click();
    const dialog = frame.getByRole("dialog", { name: "Yeni etkinlik" });
    await dialog.getByRole("textbox", { name: "Başlık" }).fill("Spor");
    await dialog.locator('input[type="time"]').first().fill("18:00");
    await dialog.getByRole("combobox", { name: "Yinele" }).selectOption("daily");
    await dialog.getByRole("button", { name: "Kaydet" }).click();
    await expect(dialog).toHaveCount(0);
    // Every day from today on: a chip in each remaining day of the month grid.
    await expect(frame.locator(".cal-chip-title", { hasText: "Spor" }).first()).toBeVisible();
    expect(await frame.locator(".cal-chip-title", { hasText: "Spor" }).count()).toBeGreaterThan(5);

    await frame.getByRole("tab", { name: "Hafta" }).click();
    const block = frame.locator(".cal-block", { hasText: "Spor" }).first();
    await expect(block).toBeVisible();
    // 18:00 → 19:00: an hour tall in the time grid, below the 17:00 line.
    const box = (await block.boundingBox())!;
    expect(box.height).toBeGreaterThan(40);
    expect(await block.evaluate((element) => (element as HTMLElement).style.top)).toBe("864px");
  });
});

test.describe("Whiteboard", () => {
  const whiteboard = OFFICIAL.find((app) => app.slug === "whiteboard")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${whiteboard.id}`, { confirm: true });
  });

  test("draws, keeps the board, and exports it as SVG and PNG", async ({ page }) => {
    test.setTimeout(120_000);
    const problems: string[] = [];
    page.on("console", (message) => {
      // Excalidraw's in-browser glyph subsetting needs eval, which apps may not use: it embeds
      // the whole font files instead (and says so). Anything else the policy blocks is a problem.
      if (
        /Content Security Policy|Refused to/.test(message.text()) &&
        !message.text().startsWith("Skipped glyph subsetting")
      )
        problems.push(message.text());
    });
    page.on("requestfailed", (request) =>
      problems.push(`${request.url()} ${request.failure()?.errorText}`),
    );
    await install(page, whiteboard);
    let { window, frame } = await open(page, whiteboard.name, whiteboard.id);
    const canvas = frame.locator("canvas.interactive");
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    // A rectangle with the keyboard tool and a drag, then text.
    await canvas.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("r");
    await page.mouse.move(box.x + 200, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 360, box.y + 300, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.press("t");
    await page.mouse.click(box.x + 420, box.y + 240);
    await page.keyboard.type("Merhaba");
    await page.keyboard.press("Escape");

    // Closed at once, before the pause that saves: the drawing is stashed as the window closes.
    // Reopened: the same drawing, exported as SVG through the desktop's save dialog.
    await window.getByRole("button", { name: "Kapat" }).first().click();
    ({ window, frame } = await open(page, whiteboard.name, whiteboard.id));
    await expect(frame.locator("canvas.interactive")).toBeVisible();
    await frame.getByRole("button", { name: "SVG" }).click();
    const picker = window.getByTestId("desktop-app-file-picker");
    await picker.getByRole("button", { name: "Kaydet" }).click();
    await expect(frame.getByText("Tahtam.svg kaydedildi")).toBeVisible({ timeout: 20_000 });
    const svg = await page.evaluate(async () => {
      const response = await fetch("/api/files/text?root=home&path=Belgeler/Tahtam.svg");
      return ((await response.json()) as { content: string }).content;
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("Merhaba");
    expect(svg).toMatch(/<path|<rect/);
    // The handwriting font travels inside the SVG.
    expect(svg).toContain("@font-face");

    await frame.getByRole("button", { name: "PNG" }).click();
    await picker.getByRole("button", { name: "Kaydet" }).click();
    await expect(frame.getByText("Tahtam.png kaydedildi")).toBeVisible({ timeout: 20_000 });
    expect(problems).toEqual([]);
  });
});
