import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir, uptime } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { capabilityInfo, type AppCapability } from "../../packages/app-manifest/src/index.ts";
import { CSRF_HEADER } from "../../packages/shared/src/index.ts";
import { makePdf } from "../../official-apps/pdf/test/make-pdf.ts";
import { signIn } from "./helpers.ts";
import { startDnsFixture } from "./dns-fixture.ts";
import { startTlsFixture } from "./tls-fixture.ts";
import { startHttpFixture } from "./http-fixture.ts";

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

test.describe("DNS Lookup", () => {
  const dnsApp = OFFICIAL.find((app) => app.slug === "dns")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${dnsApp.id}`, { confirm: true });
  });

  test("queries an approved resolver over UDP, recovers from a blocked target and keeps history", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const dns = await startDnsFixture();
    try {
      await install(page, dnsApp);
      let { window, frame } = await open(page, dnsApp.name, dnsApp.id);
      await frame
        .getByRole("textbox", { name: "Ad veya PTR için IP adresi" })
        .fill("printer.home.arpa");
      await frame.getByRole("combobox", { name: "Kayıt türü" }).selectOption("A");
      await frame
        .getByRole("combobox", { name: "Çözümleyici", exact: true })
        .selectOption("custom");
      await frame.getByRole("textbox", { name: "Çözümleyici IP adresi" }).fill("127.0.0.1");
      await frame.getByRole("spinbutton", { name: "DNS portu" }).fill(String(dns.port));
      await frame.getByRole("button", { name: "Sorgula", exact: true }).click();
      await expect(frame.getByRole("alert")).toContainText(`127.0.0.1:${dns.port}`);
      await expect(frame.getByRole("alert")).toContainText("Uygulama Mağazası");
      expect(dns.queries).toEqual([]);
      const rule = await api(page, "POST", "/api/desktop-apps/network-rules", {
        kind: "cidr",
        pattern: "127.0.0.1/32",
        ports: [dns.port],
        appId: dnsApp.id,
      });
      expect(rule.status, rule.text).toBe(201);
      await frame.getByRole("button", { name: "Sorgula", exact: true }).click();
      await expect(frame.getByRole("table", { name: "A kayıtları" })).toContainText("192.0.2.40");
      await expect(frame.getByRole("table", { name: "A kayıtları" })).toContainText("300");
      expect(dns.queries).toEqual(["printer.home.arpa"]);
      await window.getByRole("button", { name: "Kapat", exact: true }).first().click();
      ({ window, frame } = await open(page, dnsApp.name, dnsApp.id));
      await expect(frame.getByRole("textbox", { name: "Çözümleyici IP adresi" })).toHaveValue(
        "127.0.0.1",
      );
      await expect(frame.getByRole("spinbutton", { name: "DNS portu" })).toHaveValue(
        String(dns.port),
      );
      await frame.getByRole("button", { name: /printer.home.arpa/ }).click();
      await expect(frame.getByRole("table", { name: "A kayıtları" })).toContainText("192.0.2.40");
      expect(dns.queries).toHaveLength(2);
      await page.setViewportSize({ width: 390, height: 844 });
      // The responsive host replaces desktop windows with its mobile launcher.
      await expect(page.getByTestId("mobile-shell")).toBeVisible();
      await page
        .getByTestId("mobile-shell")
        .getByRole("button", { name: dnsApp.name, exact: true })
        .click();
      frame = page.frameLocator(`[data-testid="desktop-app-frame"][data-app-id="${dnsApp.id}"]`);
      await frame.getByRole("button", { name: /printer.home.arpa/ }).click();
      await expect(frame.getByRole("button", { name: "Sorgula", exact: true })).toBeVisible();
      await expect(frame.getByRole("table", { name: "A kayıtları" })).toContainText("192.0.2.40");
      expect(dns.queries).toHaveLength(3);
      const overflow = await frame
        .locator(".dns-layout")
        .evaluate((element) => element.scrollWidth > element.clientWidth);
      expect(overflow).toBe(false);
      await page.screenshot({ path: test.info().outputPath("dns-mobile.png") });
    } finally {
      await dns.close();
    }
  });
});

test.describe("SSL Inspector", () => {
  const sslApp = OFFICIAL.find((app) => app.slug === "ssl")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${sslApp.id}`, { confirm: true });
  });

  test("inspects a real TLS certificate, distinguishes trust from identity and remembers endpoints", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const tls = await startTlsFixture();
    try {
      await install(page, sslApp);
      const rule = await api(page, "POST", "/api/desktop-apps/network-rules", {
        kind: "cidr",
        pattern: "127.0.0.1/32",
        ports: [tls.port],
        appId: sslApp.id,
      });
      expect(rule.status, rule.text).toBe(201);
      let { window, frame } = await open(page, sslApp.name, sslApp.id);
      await frame
        .getByRole("textbox", { name: "Ana bilgisayar adı veya IP adresi" })
        .fill("127.0.0.1");
      await frame.getByRole("spinbutton", { name: "TLS portu" }).fill(String(tls.port));
      await frame
        .getByRole("textbox", { name: "Sunucu adı (SNI), isteğe bağlı" })
        .fill("everyos-ssl-test.home.arpa");
      await frame.getByRole("button", { name: "İncele", exact: true }).click();
      await expect(frame.getByText("Ad sertifikayla eşleşiyor", { exact: true })).toBeVisible();
      await expect(
        frame.getByText("Zincir, bu sunucunun güvenilen kök sertifikalarıyla doğrulanamadı.", {
          exact: false,
        }),
      ).toBeVisible();
      await expect(frame.getByText("Kendinden imzalı", { exact: true })).toBeVisible();
      await expect(
        frame.getByText("Sertifikanın süresi 30 gün içinde dolacak", { exact: true }),
      ).toBeVisible();
      await expect(frame.locator(".ssl-results")).toContainText("DNS:everyos-ssl-test.home.arpa");
      await expect(frame.locator(".ssl-results")).toContainText(/TLSv1\.[23]/);
      await expect(
        frame.locator(".ssl-certificate dd").filter({ hasText: /^[A-F0-9]{2}(:[A-F0-9]{2}){31}$/ }),
      ).toBeVisible();
      await frame.getByRole("button", { name: "Hedefi kaydet", exact: true }).click();
      await window.getByRole("button", { name: "Kapat", exact: true }).first().click();
      ({ window, frame } = await open(page, sslApp.name, sslApp.id));
      await frame
        .locator(".ssl-endpoint > .eui-item")
        .filter({ hasText: `127.0.0.1:${tls.port}` })
        .click();
      await expect(frame.getByText("Ad sertifikayla eşleşiyor", { exact: true })).toBeVisible();
      await frame
        .getByRole("textbox", { name: "Sunucu adı (SNI), isteğe bağlı" })
        .fill("mismatch.test");
      await frame.getByRole("button", { name: "İncele", exact: true }).click();
      await expect(
        frame.getByText("Sertifika, istenen sunucu adıyla eşleşmiyor.", { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("ssl-desktop.png") });
      await page.setViewportSize({ width: 360, height: 800 });
      await expect(page.getByTestId("mobile-shell")).toBeVisible();
      await page
        .getByTestId("mobile-shell")
        .getByRole("button", { name: sslApp.name, exact: true })
        .click();
      frame = page.frameLocator(`[data-testid="desktop-app-frame"][data-app-id="${sslApp.id}"]`);
      await frame
        .locator(".ssl-endpoint > .eui-item")
        .filter({ hasText: `127.0.0.1:${tls.port}` })
        .click();
      await expect(frame.getByText("Ad sertifikayla eşleşiyor", { exact: true })).toBeVisible();
      const overflow = await frame
        .locator(".ssl-layout")
        .evaluate((element) => element.scrollWidth > element.clientWidth);
      expect(overflow).toBe(false);
      await page.screenshot({ path: test.info().outputPath("ssl-mobile.png") });
    } finally {
      await tls.close();
    }
  });
});

test.describe("HTTP Monitor", () => {
  test.use({ actionTimeout: 20000 });
  const monitorApp = OFFICIAL.find((app) => app.slug === "httpmonitor")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${monitorApp.id}`, { confirm: true });
  });

  test("checks an approved endpoint, keeps monitoring while closed and restores real failure history on mobile", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const upstream = await startHttpFixture();
    try {
      await install(page, monitorApp);
      let { window, frame } = await open(page, monitorApp.name, monitorApp.id);
      await frame.getByRole("button", { name: "Yeni izleyici", exact: true }).click();
      await frame.getByRole("textbox", { name: "Ad", exact: true }).fill("Ev servisi");
      await frame.getByRole("textbox", { name: "HTTP veya HTTPS adresi" }).fill(upstream.url);
      await frame
        .getByRole("textbox", { name: "Yanıtta bulunması gereken metin (isteğe bağlı)" })
        .fill("ready");
      await frame.getByRole("button", { name: "İzleyiciyi kaydet", exact: true }).click();
      await expect(frame.getByRole("dialog").getByRole("alert")).toContainText(
        `127.0.0.1:${upstream.port}`,
      );
      expect(upstream.checks).toEqual([]);
      const rule = await api(page, "POST", "/api/desktop-apps/network-rules", {
        kind: "cidr",
        pattern: "127.0.0.1/32",
        ports: [upstream.port],
        appId: monitorApp.id,
      });
      expect(rule.status, rule.text).toBe(201);
      await frame.getByRole("button", { name: "İzleyiciyi kaydet", exact: true }).click();
      await expect(frame.getByRole("heading", { name: "Ev servisi", exact: true })).toBeVisible();
      await frame.getByRole("button", { name: "Şimdi kontrol et", exact: true }).click();
      await expect(frame.getByRole("table", { name: "Kontrol geçmişi" })).toContainText("200");
      expect(upstream.checks.some((check) => check.method === "GET" && check.status === 200)).toBe(
        true,
      );
      await page.screenshot({ path: test.info().outputPath("http-monitor-desktop.png") });
      await window.getByRole("button", { name: "Kapat", exact: true }).first().click();
      upstream.setStatus(503);
      // Wait for the real 60-second server schedule with no app frame alive.
      await expect
        .poll(() => upstream.checks.some((check) => check.status === 503), {
          timeout: 80000,
          intervals: [1000],
        })
        .toBe(true);
      ({ window, frame } = await open(page, monitorApp.name, monitorApp.id));
      await expect(frame.getByRole("table", { name: "Kontrol geçmişi" })).toContainText("503");
      await expect(
        frame.getByText("Beklenmeyen HTTP durumu", { exact: true }).first(),
      ).toBeVisible();
      await expect(frame.locator(".monitor-heading")).toContainText("Kesinti");
      const notifications = await api(page, "GET", "/api/notifications?limit=100");
      expect(notifications.status).toBe(200);
      expect(notifications.text).toContain("app-monitor-down");
      expect(notifications.text).toContain("Ev servisi");
      await frame.getByRole("button", { name: "CSV dışa aktar", exact: true }).click();
      const picker = window.getByTestId("desktop-app-file-picker");
      await expect(picker).toContainText("Farklı kaydet");
      const exportName = `http-monitor-test-${Date.now()}.csv`;
      await picker.getByRole("textbox", { name: "Ad", exact: true }).fill(exportName);
      await picker.getByRole("button", { name: "Kaydet", exact: true }).click();
      await expect
        .poll(async () => {
          const response = await api(
            page,
            "GET",
            `/api/files/text?root=home&path=Belgeler/${exportName}`,
          );
          return response.status === 200
            ? (JSON.parse(response.text) as { content: string }).content
            : null;
        })
        .toContain('"false","503"');
      await frame.getByRole("button", { name: "Duraklat", exact: true }).click();
      await expect(frame.locator(".monitor-heading")).toContainText("Duraklatıldı");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId("mobile-shell")).toBeVisible();
      await page
        .getByTestId("mobile-shell")
        .getByRole("button", { name: monitorApp.name, exact: true })
        .click();
      frame = page.frameLocator(
        `[data-testid="desktop-app-frame"][data-app-id="${monitorApp.id}"]`,
      );
      await expect(frame.getByRole("table", { name: "Kontrol geçmişi" })).toContainText("503");
      expect(
        await frame
          .locator(".monitor-main")
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      ).toBe(false);
      await page.screenshot({ path: test.info().outputPath("http-monitor-mobile.png") });
    } finally {
      await upstream.close();
    }
  });
});

test.describe("Port Inspector", () => {
  const portsApp = OFFICIAL.find((app) => app.slug === "ports")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${portsApp.id}`, { confirm: true });
  });

  test("reads actual Linux listeners or explains host unavailability, preserves filters and fits mobile", async ({
    page,
  }) => {
    test.setTimeout(90000);
    const upstream = await startHttpFixture();
    try {
      await install(page, portsApp);
      let { window, frame } = await open(page, portsApp.name, portsApp.id);
      const search = frame.getByRole("searchbox", { name: "Dinleyicilerde ara" });
      await expect(search).toBeVisible();
      if (process.platform === "linux") {
        // The fixture listens in the same real host namespace as the agent's /proc collector.
        // A previous read may still be in the agent's 30-second cache.
        await search.fill(String(upstream.port));
        await expect
          .poll(
            async () => {
              await frame.getByRole("button", { name: "Yenile", exact: true }).click();
              return frame.locator("tbody").innerText();
            },
            { timeout: 45000, intervals: [1000, 5000] },
          )
          .toContain(String(upstream.port));
        await expect(frame.getByText("Host verisi", { exact: true })).toBeVisible();
        await expect(frame.getByRole("table", { name: "Dinleme soketleri" })).toContainText("TCP");
        await expect(frame.getByRole("table", { name: "Dinleme soketleri" })).toContainText(
          "127.0.0.1",
        );
        await frame.getByRole("button", { name: "CSV dışa aktar", exact: true }).click();
        const picker = window.getByTestId("desktop-app-file-picker");
        const exportName = `listening-ports-test-${Date.now()}.csv`;
        await picker.getByRole("textbox", { name: "Ad", exact: true }).fill(exportName);
        await picker.getByRole("button", { name: "Kaydet", exact: true }).click();
        await expect
          .poll(async () => {
            const response = await api(
              page,
              "GET",
              `/api/files/text?root=home&path=Belgeler/${exportName}`,
            );
            return response.status === 200
              ? (JSON.parse(response.text) as { content: string }).content
              : null;
          })
          .toContain(`"tcp","127.0.0.1","${upstream.port}"`);
        expect(upstream.checks).toEqual([]);
      } else {
        await expect(frame.getByRole("alert")).toContainText("Linux ve okunabilir /proc");
        await expect(frame.getByRole("table", { name: "Dinleme soketleri" })).toHaveCount(0);
        await search.fill("8080");
      }
      await expect(frame.getByRole("combobox", { name: "Protokol", exact: true })).toBeVisible();
      await frame.getByRole("combobox", { name: "Protokol", exact: true }).selectOption("tcp");
      await window.getByRole("button", { name: "Kapat", exact: true }).first().click();
      ({ window, frame } = await open(page, portsApp.name, portsApp.id));
      await expect(frame.getByRole("searchbox", { name: "Dinleyicilerde ara" })).toHaveValue(
        process.platform === "linux" ? String(upstream.port) : "8080",
      );
      await expect(frame.getByRole("combobox", { name: "Protokol", exact: true })).toHaveValue(
        "tcp",
      );
      await page.screenshot({ path: test.info().outputPath("ports-desktop.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId("mobile-shell")).toBeVisible();
      await page
        .getByTestId("mobile-shell")
        .getByRole("button", { name: portsApp.name, exact: true })
        .click();
      frame = page.frameLocator(`[data-testid="desktop-app-frame"][data-app-id="${portsApp.id}"]`);
      await expect(frame.getByRole("combobox", { name: "Protokol", exact: true })).toHaveValue(
        "tcp",
      );
      expect(
        await frame
          .locator(".ports-main")
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      ).toBe(false);
      await page.screenshot({ path: test.info().outputPath("ports-mobile.png") });
    } finally {
      await upstream.close();
    }
  });
});

test.describe("Network Tools", () => {
  const networkApp = OFFICIAL.find((app) => app.slug === "network")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${networkApp.id}`, { confirm: true });
  });

  test("reads host interfaces, checks an approved endpoint, exports diagnostics and restores the mobile draft", async ({
    page,
  }) => {
    test.setTimeout(90000);
    const upstream = await startHttpFixture();
    try {
      await install(page, networkApp);
      let { window, frame } = await open(page, networkApp.name, networkApp.id);
      await expect(frame.locator(".network-interface").first()).toBeVisible();
      await frame
        .getByRole("combobox", { name: "Arayüz", exact: true })
        .selectOption(process.platform === "linux" ? "lo" : "lo0");
      await expect(frame.getByText("127.0.0.1/8", { exact: true })).toBeVisible();
      await expect(frame.getByText("Host verisi", { exact: true }).first()).toBeVisible();
      await frame.getByRole("textbox", { name: "HTTP veya HTTPS adresi" }).fill(upstream.url);
      await frame.getByRole("button", { name: "Hedefi kontrol et", exact: true }).click();
      await expect(
        frame.getByRole("alert").filter({ hasText: `127.0.0.1:${upstream.port}` }),
      ).toContainText("Uygulama Mağazası");
      expect(upstream.checks).toEqual([]);
      const rule = await api(page, "POST", "/api/desktop-apps/network-rules", {
        kind: "cidr",
        pattern: "127.0.0.1/32",
        ports: [upstream.port],
        appId: networkApp.id,
      });
      expect(rule.status, rule.text).toBe(201);
      await frame.getByRole("button", { name: "Hedefi kontrol et", exact: true }).click();
      await expect(frame.getByText("HTTP yanıtı alındı", { exact: true })).toBeVisible();
      await expect(frame.locator(".network-probe-result")).toContainText("200 OK");
      expect(upstream.checks).toEqual([{ method: "HEAD", status: 200 }]);
      await frame.getByRole("button", { name: "Raporu dışa aktar", exact: true }).click();
      const picker = window.getByTestId("desktop-app-file-picker");
      const exportName = `network-diagnostics-test-${Date.now()}.json`;
      await picker.getByRole("textbox", { name: "Ad", exact: true }).fill(exportName);
      await picker.getByRole("button", { name: "Kaydet", exact: true }).click();
      await expect
        .poll(async () => {
          const saved = await api(
            page,
            "GET",
            `/api/files/text?root=home&path=Belgeler/${exportName}`,
          );
          if (saved.status !== 200) return null;
          try {
            const file = JSON.parse(saved.text) as { content: string };
            return (JSON.parse(file.content) as { probe: { response: { status: number } } }).probe
              .response.status;
          } catch {
            return null;
          }
        })
        .toBe(200);
      const saved = await api(page, "GET", `/api/files/text?root=home&path=Belgeler/${exportName}`);
      const content = (JSON.parse(saved.text) as { content: string }).content;
      const diagnostics = JSON.parse(content) as {
        network: { value: { source: string; interfaces: unknown[] } };
        probe: { response: { status: number; headers?: unknown; body?: unknown } };
      };
      expect(diagnostics.network.value.source).toBe("host");
      expect(diagnostics.network.value.interfaces.length).toBeGreaterThan(0);
      expect(diagnostics.probe.response.status).toBe(200);
      expect(diagnostics.probe.response).not.toHaveProperty("headers");
      expect(diagnostics.probe.response).not.toHaveProperty("body");
      await frame.locator(".eui-content").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: test.info().outputPath("network-desktop.png") });
      await window.getByRole("button", { name: "Kapat", exact: true }).first().click();
      ({ window, frame } = await open(page, networkApp.name, networkApp.id));
      await expect(frame.getByRole("textbox", { name: "HTTP veya HTTPS adresi" })).toHaveValue(
        upstream.url,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId("mobile-shell")).toBeVisible();
      await page
        .getByTestId("mobile-shell")
        .getByRole("button", { name: networkApp.name, exact: true })
        .click();
      frame = page.frameLocator(
        `[data-testid="desktop-app-frame"][data-app-id="${networkApp.id}"]`,
      );
      await frame.getByRole("button", { name: "Hedefi kontrol et", exact: true }).click();
      await expect(frame.getByText("HTTP yanıtı alındı", { exact: true })).toBeVisible();
      expect(
        await frame
          .locator(".network-main")
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      ).toBe(false);
      expect(upstream.checks).toHaveLength(2);
      await frame.locator(".eui-content").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: test.info().outputPath("network-mobile.png") });
    } finally {
      await upstream.close();
    }
  });
});

test.describe("Log Viewer", () => {
  test.use({ actionTimeout: 20000 });
  const logsApp = OFFICIAL.find((app) => app.slug === "logs")!;
  test.afterEach(async ({ page }) => {
    await page.evaluate(() =>
      (window as Window & { __sdkLogFixture?: EventSource }).__sdkLogFixture?.close(),
    );
    await api(page, "DELETE", `/api/desktop-apps/installed/${logsApp.id}`, { confirm: true });
  });

  test("labels simulated journal data, polls live, pauses, saves a filter and exports loaded records through the sandbox", async ({
    page,
  }) => {
    test.setTimeout(90000);
    await install(page, logsApp);
    const opened = await open(page, logsApp.name, logsApp.id);
    const { window } = opened;
    let { frame } = opened;
    const records = () => frame.getByRole("table", { name: "Günlük kayıtları" });
    await expect(frame.getByText("Simüle veri", { exact: true })).toBeVisible();
    await expect(frame.getByRole("status")).toContainText("simüle edilir");
    await expect(records().locator("tbody tr")).toHaveCount(100);
    // The read-only development stream produces explicitly simulated records for the SDK poller.
    await page.evaluate(() => {
      (globalThis as typeof globalThis & { __sdkLogFixture?: EventSource }).__sdkLogFixture =
        new EventSource("/api/logs/stream");
    });
    const before = await records().locator("tbody tr").first().innerText();
    await frame.getByRole("button", { name: "Canlı yenilemeyi başlat", exact: true }).click();
    await expect
      .poll(() => records().locator("tbody tr").first().innerText(), { timeout: 15000 })
      .not.toBe(before);
    await frame.getByRole("button", { name: "Canlı yenilemeyi duraklat", exact: true }).click();
    await expect(frame.getByText("Yenileme duraklatıldı", { exact: true })).toBeVisible();
    const paused = await records().locator("tbody tr").first().innerText();
    await page.waitForTimeout(6500);
    expect(await records().locator("tbody tr").first().innerText()).toBe(paused);
    await page.evaluate(() =>
      (
        globalThis as typeof globalThis & { __sdkLogFixture?: EventSource }
      ).__sdkLogFixture?.close(),
    );
    const sample = JSON.parse((await api(page, "GET", "/api/logs?limit=1")).text) as {
      source: string;
      entries: { unit: string | null; priority: number; message: string }[];
    };
    expect(sample.source).toBe("simulated");
    const entry = sample.entries[0]!;
    const search = entry.message.slice(0, 30);
    await frame.getByRole("searchbox", { name: "Mesajlarda ara" }).fill(search);
    await frame.getByRole("textbox", { name: "Systemd birimi" }).fill(entry.unit ?? "");
    await frame
      .getByRole("combobox", { name: "Önem düzeyi", exact: true })
      .selectOption(String(entry.priority));
    await frame.getByRole("button", { name: "Uygula", exact: true }).click();
    await expect(records()).toContainText(search);
    await frame.getByRole("button", { name: "Filtreyi kaydet", exact: true }).click();
    const prompt = window.getByRole("alertdialog", { name: "Geçerli filtreyi kaydet" });
    await prompt
      .getByRole("textbox", { name: "Geçerli filtreyi kaydet" })
      .fill("Tarayıcı günlük filtresi");
    await prompt.getByRole("button", { name: "Onayla", exact: true }).click();
    await expect(prompt).toHaveCount(0);
    await frame.getByRole("button", { name: "JSON dışa aktar", exact: true }).click();
    const picker = window.getByTestId("desktop-app-file-picker");
    const exportName = `journal-test-${Date.now()}.json`;
    await picker.getByRole("textbox", { name: "Ad", exact: true }).fill(exportName);
    await picker.getByRole("button", { name: "Kaydet", exact: true }).click();
    await expect
      .poll(async () => {
        const saved = await api(
          page,
          "GET",
          `/api/files/text?root=home&path=Belgeler/${exportName}`,
        );
        if (saved.status !== 200) return null;
        try {
          return (
            JSON.parse((JSON.parse(saved.text) as { content: string }).content) as {
              source: string;
            }
          ).source;
        } catch {
          return null;
        }
      })
      .toBe("simulated");
    const saved = await api(page, "GET", `/api/files/text?root=home&path=Belgeler/${exportName}`);
    const report = JSON.parse((JSON.parse(saved.text) as { content: string }).content) as {
      entries: { message: string; priority: number }[];
      filter: { search: string };
    };
    expect(report.entries.length).toBeGreaterThan(0);
    expect(report.filter.search).toBe(search);
    expect(
      report.entries.every(
        (row) =>
          row.message.toLowerCase().includes(search.toLowerCase()) &&
          row.priority <= entry.priority,
      ),
    ).toBe(true);
    await frame.locator(".eui-content").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: test.info().outputPath("logs-desktop.png") });
    await window.getByRole("button", { name: "Kapat", exact: true }).first().click();
    ({ frame } = await open(page, logsApp.name, logsApp.id));
    await expect(frame.getByRole("searchbox", { name: "Mesajlarda ara" })).toHaveValue(search);
    await expect(
      frame.getByRole("button", { name: "Tarayıcı günlük filtresi", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("mobile-shell")).toBeVisible();
    await page
      .getByTestId("mobile-shell")
      .getByRole("button", { name: logsApp.name, exact: true })
      .click();
    frame = page.frameLocator(`[data-testid="desktop-app-frame"][data-app-id="${logsApp.id}"]`);
    await expect(frame.getByRole("searchbox", { name: "Mesajlarda ara" })).toHaveValue(search);
    await expect(frame.getByRole("table", { name: "Günlük kayıtları" })).toContainText(search);
    expect(
      await frame
        .locator(".logs-main")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(false);
    await page.screenshot({ path: test.info().outputPath("logs-mobile.png") });
  });
});

test.describe("Disk Explorer", () => {
  test.use({ actionTimeout: 20000 });
  const diskApp = OFFICIAL.find((app) => app.slug === "disk")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${diskApp.id}`, { confirm: true });
  });

  test("measures a shared folder, records real growth, exports its scope and restores navigation on mobile", async ({
    page,
  }) => {
    test.setTimeout(90000);
    await install(page, diskApp);
    const name = `disk-test-${Date.now()}`;
    const base = `Belgeler/${name}`;
    for (const [path, child] of [
      ["Belgeler", name],
      [base, "media"],
    ]) {
      const created = await api(page, "POST", "/api/files/mkdir", {
        root: "home",
        path,
        name: child,
      });
      expect(created.status, created.text).toBe(201);
    }
    const upload = async (path: string, fileName: string, size: number) => {
      expect(
        await page.evaluate(
          async ({ path, fileName, size, header }) => {
            const session = (await (await fetch("/api/auth/session")).json()) as {
              csrfToken: string;
            };
            return (
              await fetch(
                `/api/files/upload?root=home&path=${encodeURIComponent(path)}&name=${encodeURIComponent(fileName)}`,
                {
                  method: "POST",
                  headers: { [header]: session.csrfToken },
                  body: "x".repeat(size),
                },
              )
            ).status;
          },
          { path, fileName, size, header: CSRF_HEADER },
        ),
      ).toBe(201);
    };
    await upload(base, "readme.txt", 128);
    await upload(`${base}/media`, "large.bin", 4096);
    await upload(`${base}/media`, "photo.jpg", 2048);
    await upload("Belgeler", `${name}-outside.txt`, 10000);
    const opened = await open(page, diskApp.name, diskApp.id);
    const { window } = opened;
    let { frame } = opened;
    await frame.getByRole("button", { name: "Klasör seç", exact: true }).first().click();
    const picker = window.getByTestId("desktop-app-file-picker");
    await picker.getByRole("option", { name, exact: true }).click();
    await picker.getByRole("button", { name: "Bu klasörü seç", exact: true }).click();
    const table = () => frame.getByRole("table", { name: "Dosyalar ve klasörler", exact: true });
    await expect(table().locator("tbody tr")).toHaveCount(2);
    await expect(
      frame.getByRole("table", { name: "En büyük dosyalar", exact: true }),
    ).toContainText("media/large.bin");
    await expect(
      frame.getByRole("table", { name: "Dosya türü istatistikleri", exact: true }),
    ).toContainText(".jpg");
    await frame.getByRole("button", { name: "media", exact: true }).click();
    await expect(table()).toContainText("large.bin");
    await expect(table()).not.toContainText("readme.txt");
    await frame.getByRole("button", { name: "Üst klasör", exact: true }).click();
    await expect(table()).toContainText("readme.txt");
    await upload(base, "growth.bin", 512);
    // The app keeps at most one actual observation per 15-second interval.
    await page.waitForTimeout(16000);
    await frame.getByRole("button", { name: "Yenile", exact: true }).click();
    await expect(table().locator("tbody tr")).toHaveCount(3);
    await expect(
      frame.getByRole("img", { name: "Ölçülen depolama eğilimi", exact: true }),
    ).toBeVisible();
    await frame.getByRole("button", { name: "Raporu dışa aktar", exact: true }).click();
    const save = window.getByTestId("desktop-app-file-picker");
    const exportName = `${name}.json`;
    await save.getByRole("textbox", { name: "Ad", exact: true }).fill(exportName);
    await save.getByRole("button", { name: "Kaydet", exact: true }).click();
    await expect(save).toHaveCount(0);
    let exported = "";
    await expect
      .poll(async () => {
        const response = await api(
          page,
          "GET",
          `/api/files/text?root=home&path=Belgeler/${exportName}`,
        );
        if (response.status !== 200) return null;
        try {
          exported = (JSON.parse(response.text) as { content: string }).content;
          return JSON.parse(exported) as unknown;
        } catch {
          // The picker creates the destination before the bridge finishes writing its contents.
          return null;
        }
      })
      .toMatchObject({
        folder: {
          name,
          path: "",
          source: "host",
          total: 6784,
          files: 4,
          folders: 1,
          truncated: false,
        },
        storage: { value: { source: "host" } },
      });
    const report = JSON.parse(exported) as {
      history: { scope: { kind: string; path?: string }; samples: { bytes: number }[] }[];
    };
    const trend = report.history.find(
      (value) => value.scope.kind === "folder" && value.scope.path === "",
    );
    expect(trend!.samples.map((value) => value.bytes)).toEqual([6272, 6784]);
    expect(exported).not.toContain(`${name}-outside.txt`);
    await frame.getByRole("tab", { name: "Bağlı depolama", exact: true }).click();
    await expect(
      frame.getByRole("combobox", { name: "Bağlama noktası", exact: true }),
    ).toBeVisible();
    await expect(frame.getByRole("meter", { name: "Kullanılan alan", exact: true })).toBeVisible();
    await frame.getByRole("tab", { name: "Klasör", exact: true }).click();
    await frame.locator(".eui-content").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: test.info().outputPath("disk-desktop.png") });
    await frame.getByRole("button", { name: "media", exact: true }).click();
    await expect(table()).toContainText("large.bin");
    await window.getByRole("button", { name: "Kapat", exact: true }).first().click();
    ({ frame } = await open(page, diskApp.name, diskApp.id));
    await expect(table()).toContainText("large.bin");
    await expect(table()).not.toContainText("readme.txt");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("mobile-shell")).toBeVisible();
    await page
      .getByTestId("mobile-shell")
      .getByRole("button", { name: diskApp.name, exact: true })
      .click();
    frame = page.frameLocator(`[data-testid="desktop-app-frame"][data-app-id="${diskApp.id}"]`);
    await expect(table()).toContainText("large.bin");
    expect(
      await frame
        .locator(".disk-main")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(false);
    await page.screenshot({ path: test.info().outputPath("disk-mobile.png") });
  });
});

test.describe("Uptime", () => {
  test.use({ actionTimeout: 20000 });
  const uptimeApp = OFFICIAL.find((app) => app.slug === "uptime")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${uptimeApp.id}`, { confirm: true });
  });
  test("reads real host uptime, observes approved endpoint failures, notifies and shares health with its widget", async ({
    page,
  }) => {
    test.setTimeout(120000);
    const upstream = await startHttpFixture();
    try {
      await install(page, uptimeApp);
      const opened = await open(page, uptimeApp.name, uptimeApp.id);
      const appWindow = opened.window;
      let { frame } = opened;
      const duration = frame.locator(".uptime-duration");
      await expect(duration).toHaveText(/^\d+g \d+sa \d+dk \d+sn$/);
      const parts = (await duration.innerText()).match(/^(\d+)g (\d+)sa (\d+)dk (\d+)sn$/)!;
      const measuredSeconds =
        Number(parts[1]) * 86400 +
        Number(parts[2]) * 3600 +
        Number(parts[3]) * 60 +
        Number(parts[4]);
      expect(Math.abs(uptime() - measuredSeconds)).toBeLessThan(30);
      await expect(frame.getByText("Simüle veri", { exact: true })).toBeVisible();
      await expect(frame.getByText("Yetersiz veri", { exact: true })).toBeVisible();
      await frame.getByRole("button", { name: "Yeni izleyici", exact: true }).click();
      await frame.getByRole("textbox", { name: "Ad", exact: true }).fill("Yerel sağlık");
      await frame
        .getByRole("textbox", { name: "HTTP veya HTTPS adresi", exact: true })
        .fill(upstream.url);
      await frame.getByRole("button", { name: "İzleyiciyi kaydet", exact: true }).click();
      await expect(frame.getByRole("dialog").getByRole("alert")).toContainText(
        `127.0.0.1:${upstream.port}`,
      );
      expect(upstream.checks).toEqual([]);
      const rule = await api(page, "POST", "/api/desktop-apps/network-rules", {
        kind: "cidr",
        pattern: "127.0.0.1/32",
        ports: [upstream.port],
        appId: uptimeApp.id,
      });
      expect(rule.status, rule.text).toBe(201);
      await frame.getByRole("button", { name: "İzleyiciyi kaydet", exact: true }).click();
      await expect(frame.getByRole("heading", { name: "Yerel sağlık", exact: true })).toBeVisible();
      await frame.getByRole("button", { name: "Şimdi kontrol et", exact: true }).click();
      await expect(
        frame.getByRole("table", { name: "Kontrol geçmişi", exact: true }),
      ).toContainText("200");
      expect(upstream.checks.some((check) => check.status === 200 && check.method === "GET")).toBe(
        true,
      );
      upstream.setStatus(503);
      await frame.getByRole("button", { name: "Şimdi kontrol et", exact: true }).click();
      await expect(
        frame.getByRole("table", { name: "Kontrol geçmişi", exact: true }),
      ).toContainText("503");
      await expect(frame.getByText("İlk hata gözlendi", { exact: true })).toBeVisible();
      await expect(frame.getByText("Hata gözlendi", { exact: true })).toBeVisible();
      const notifications = await api(page, "GET", "/api/notifications?limit=100");
      expect(notifications.status).toBe(200);
      expect(notifications.text).toContain("app-monitor-down");
      expect(notifications.text).toContain("Yerel sağlık");
      await frame.locator(".eui-content").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: test.info().outputPath("uptime-desktop.png") });
      const sidebar = page.getByTestId("widget-sidebar");
      if (!(await sidebar.isVisible())) await page.getByTestId("widget-sidebar-toggle").click();
      await sidebar.getByRole("button", { name: "Widget ekle…" }).first().click();
      const gallery = page.getByRole("dialog", { name: "Widget galerisi" });
      await gallery.getByRole("tab", { name: "Uygulamalar", exact: true }).click();
      await gallery
        .getByRole("button", { name: "Ekle: Çalışma süresi özeti", exact: true })
        .click();
      await page.keyboard.press("Escape");
      const widget = sidebar.locator(
        `[data-testid="widget"][data-widget="${uptimeApp.id}#health"]`,
      );
      await expect(widget).toBeVisible();
      const health = widget.frameLocator('[data-testid="desktop-app-frame"]');
      await expect(health.getByText("Hata gözlendi", { exact: true })).toBeVisible();
      await expect(health.getByText("Simüle veri", { exact: true })).toBeVisible();
      await expect(health.getByText("Simüle veri", { exact: true })).toBeInViewport();
      await appWindow.getByRole("button", { name: "Kapat", exact: true }).first().click();
      await expect(appWindow).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("uptime-widget.png") });
      await health.getByRole("button", { name: "Çalışma Süresi’ni aç", exact: true }).click();
      const reopened = page.locator(`[data-app-id="everyos.desktop.${uptimeApp.id}"]`);
      await expect(reopened).toBeVisible();
      frame = reopened.frameLocator('[data-testid="desktop-app-frame"]');
      await expect(frame.getByRole("heading", { name: "Yerel sağlık", exact: true })).toBeVisible();
      await frame.getByRole("button", { name: "Duraklat", exact: true }).click();
      await expect(frame.getByRole("button", { name: "Etkinleştir", exact: true })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId("mobile-shell")).toBeVisible();
      await page
        .getByTestId("mobile-shell")
        .getByRole("button", { name: uptimeApp.name, exact: true })
        .click();
      frame = page.frameLocator(`[data-testid="desktop-app-frame"][data-app-id="${uptimeApp.id}"]`);
      await expect(frame.getByRole("heading", { name: "Yerel sağlık", exact: true })).toBeVisible();
      expect(
        await frame
          .locator(".uptime-main")
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      ).toBe(false);
      await page.screenshot({ path: test.info().outputPath("uptime-mobile.png") });
    } finally {
      await upstream.close();
    }
  });
});

test.describe("SSH Keys", () => {
  test.use({ actionTimeout: 20000 });
  const keysApp = OFFICIAL.find((app) => app.slug === "sshkeys")!;
  test.afterEach(async ({ page }) => {
    await api(page, "DELETE", `/api/desktop-apps/installed/${keysApp.id}`, { confirm: true });
  });

  test("generates real keys, confirms protected exports in EveryOS, imports public keys and deletes safely on mobile", async ({
    page,
  }) => {
    test.setTimeout(150000);
    await install(page, keysApp);
    const opened = await open(page, keysApp.name, keysApp.id);
    const { window } = opened;
    let { frame } = opened;
    const name = `Browser SSH ${Date.now()}`;
    const renamed = `${name} renamed`;
    const passphrase = "browser-test-only-passphrase-ü";
    const records = () => frame.getByRole("table", { name: "SSH anahtarları" });
    await frame.getByRole("button", { name: "Anahtar üret", exact: true }).click();
    let form = frame.getByRole("dialog", { name: "Anahtar üret", exact: true });
    await form.getByRole("textbox", { name: "Ad", exact: true }).fill(name);
    await form.getByRole("textbox", { name: "Açıklama", exact: true }).fill("Browser key fixture");
    await form.getByRole("button", { name: "Kaydet", exact: true }).click();
    await expect(records()).toContainText(name);
    await expect(records()).toContainText("ssh-ed25519");
    await expect(form).not.toBeVisible();
    const fingerprint = await frame.locator(".keys-detail .keys-fingerprint").innerText();
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    await frame.getByRole("button", { name: "Düzenle", exact: true }).click();
    form = frame.getByRole("dialog", { name: "Düzenle", exact: true });
    await form.getByRole("textbox", { name: "Ad", exact: true }).fill(renamed);
    await form
      .getByRole("textbox", { name: "Açıklama", exact: true })
      .fill("Updated browser comment");
    await form.getByRole("button", { name: "Kaydet", exact: true }).click();
    await expect(records()).toContainText(renamed);
    await expect(frame.locator(".keys-detail")).toContainText("Updated browser comment");
    const publicKey = await frame.locator(".keys-detail textarea").inputValue();
    const identity = (value: string) => value.trim().split(/\s+/).slice(0, 2).join(" ");
    const picker = () => page.getByTestId("desktop-app-file-picker");
    const savedText = async (file: string) => {
      const saved = await api(page, "GET", `/api/files/text?root=home&path=Belgeler/${file}`);
      if (saved.status !== 200) return "";
      try {
        return (JSON.parse(saved.text) as { content: string }).content;
      } catch {
        return "";
      }
    };
    const saveAs = async (file: string) => {
      await picker().getByRole("textbox", { name: "Ad", exact: true }).fill(file);
      await picker().getByRole("button", { name: "Kaydet", exact: true }).click();
      await expect(picker()).toHaveCount(0);
    };
    const publicFile = `ssh-browser-${Date.now()}.pub`;
    await frame.getByRole("button", { name: "Açık anahtarı dışa aktar", exact: true }).click();
    await saveAs(publicFile);
    await expect.poll(() => savedText(publicFile)).toBe(publicKey + "\n");
    await frame.locator(".eui-content").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: test.info().outputPath("sshkeys-desktop.png") });

    const openPrivate = async () => {
      await frame
        .getByRole("button", { name: "Korumalı özel anahtarı dışa aktar", exact: true })
        .click();
      const dialog = frame.getByRole("dialog", {
        name: "Korumalı özel anahtarı dışa aktar",
        exact: true,
      });
      await dialog.getByLabel("Dışa aktarma parolası", { exact: true }).fill(passphrase);
      await dialog.getByLabel("Parolayı tekrarla", { exact: true }).fill(passphrase);
      await dialog.getByRole("button", { name: "Devam et", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      return page.getByRole("alertdialog", {
        name: `“${renamed}” özel anahtarı dışa aktarılsın mı?`,
        exact: true,
      });
    };
    let approval = await openPrivate();
    await expect(approval).toContainText(fingerprint);
    await expect(approval).toContainText("EveryOS, SSH Anahtarları için soruyor");
    await expect(approval).not.toContainText(passphrase);
    await expect(frame.locator('input[type="password"]')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("sshkeys-private-approval.png") });
    await approval.getByRole("button", { name: "Vazgeç", exact: true }).click();
    await expect(approval).toHaveCount(0);
    await expect(picker()).toHaveCount(0);
    await expect(frame.getByRole("alert")).toHaveCount(0);
    approval = await openPrivate();
    await approval.getByRole("button", { name: "Özel anahtarı dışa aktar", exact: true }).click();
    const privateFile = `ssh-browser-${Date.now()}.key`;
    await saveAs(privateFile);
    await expect
      .poll(() => savedText(privateFile))
      .toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
    const protectedKey = await savedText(privateFile);
    const blob = Buffer.from(
      protectedKey.replace(/-----[^\n]+-----/g, "").replace(/\s/g, ""),
      "base64",
    );
    expect(blob.subarray(0, 15).toString()).toBe("openssh-key-v1\0");
    const cipherLength = blob.readUInt32BE(15);
    expect(blob.subarray(19, 19 + cipherLength).toString()).not.toBe("none");
    const directory = mkdtempSync(join(tmpdir(), "everyos-ssh-browser-"));
    try {
      const file = join(directory, "export.key");
      writeFileSync(file, protectedKey, { mode: 0o600 });
      // A disposable fixture passphrase verifies native OpenSSH interoperability, not host keys.
      const derived = execFileSync("ssh-keygen", ["-y", "-P", passphrase, "-f", file], {
        encoding: "utf8",
      });
      expect(identity(derived)).toBe(identity(publicKey));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    await expect(frame.locator("body")).not.toContainText(passphrase);
    await window.getByRole("button", { name: "Kapat", exact: true }).first().click();
    ({ frame } = await open(page, keysApp.name, keysApp.id));
    await expect(records()).toContainText(renamed);
    await expect(frame.locator(".keys-detail .keys-fingerprint")).toHaveText(fingerprint);

    const generated = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
    const field = (data: Buffer) => {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(data.length);
      return Buffer.concat([size, data]);
    };
    const imported = `ssh-ed25519 ${Buffer.concat([field(Buffer.from("ssh-ed25519")), field(Buffer.from(generated.x!, "base64url"))]).toString("base64")} Imported fixture`;
    const importedName = `${name} public`;
    await frame.getByRole("button", { name: "Açık anahtar içe aktar", exact: true }).click();
    form = frame.getByRole("dialog", { name: "Açık anahtar içe aktar", exact: true });
    await form.getByRole("textbox", { name: "Ad", exact: true }).fill(importedName);
    await form.getByRole("textbox", { name: "Açık anahtar", exact: true }).fill(imported);
    await form.getByRole("button", { name: "Kaydet", exact: true }).click();
    await expect(records()).toContainText(importedName);
    await expect(frame.locator(".keys-detail textarea")).toHaveValue(imported);
    await expect(
      frame.getByRole("button", { name: "Korumalı özel anahtarı dışa aktar", exact: true }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("mobile-shell")).toBeVisible();
    await page
      .getByTestId("mobile-shell")
      .getByRole("button", { name: keysApp.name, exact: true })
      .click();
    frame = page.frameLocator(`[data-testid="desktop-app-frame"][data-app-id="${keysApp.id}"]`);
    await expect(records()).toContainText(importedName);
    await expect(frame.locator(".keys-detail")).toContainText("ssh-ed25519 · 256 Bit");
    expect(
      await frame
        .locator(".keys-main")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(false);
    await page.screenshot({ path: test.info().outputPath("sshkeys-mobile.png") });
    await frame.getByRole("button", { name: "Sil", exact: true }).click();
    let deletion = page.getByRole("alertdialog", { name: "Anahtar silinsin mi?", exact: true });
    await expect(deletion).toContainText(importedName);
    await deletion.getByRole("button", { name: "Vazgeç", exact: true }).click();
    await expect(deletion).toHaveCount(0);
    await expect(records()).toContainText(importedName);
    await frame.getByRole("button", { name: "Sil", exact: true }).click();
    await deletion.getByRole("button", { name: "Sil", exact: true }).click();
    await expect(records()).not.toContainText(importedName);
    await expect(frame.locator(".keys-detail .keys-fingerprint")).toHaveText(fingerprint);
    await frame.getByRole("button", { name: "Sil", exact: true }).click();
    deletion = page.getByRole("alertdialog", {
      name: `“${renamed}” anahtarı silinsin mi?`,
      exact: true,
    });
    await expect(deletion).toContainText(fingerprint);
    await expect(deletion).toContainText("EveryOS, SSH Anahtarları için soruyor");
    await deletion.getByRole("button", { name: "Vazgeç", exact: true }).click();
    await expect(deletion).toHaveCount(0);
    await expect(records()).toContainText(renamed);
    await frame.getByRole("button", { name: "Sil", exact: true }).click();
    await deletion.getByRole("button", { name: "Anahtarı sil", exact: true }).click();
    await expect(records()).toHaveCount(0);
    await expect(frame.getByText("Eşleşen anahtar yok", { exact: true })).toBeVisible();
  });
});
