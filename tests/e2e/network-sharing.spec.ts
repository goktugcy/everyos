import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  CSRF_HEADER,
  type SessionInfo,
  type SharingOverview,
} from "../../packages/shared/src/index.ts";
import { signIn, stateDir, PASSWORD } from "./helpers.ts";

test.beforeAll(async ({ request }) => {
  // A standalone run has a fresh stack; a full-suite run may already have completed setup.
  const token = await readFile(join(stateDir, "data/setup-token"), "utf8").catch(() => null);
  if (token) {
    const response = await request.post("/api/setup", {
      headers: {
        Origin:
          "http://" +
          (process.env.EVERYOS_E2E_HTTP_HOST ?? "127.0.0.1") +
          ":" +
          (process.env.EVERYOS_E2E_PORT ?? "7480"),
      },
      data: {
        setupToken: token.trim(),
        username: "goktug",
        displayName: "Fixture",
        password: PASSWORD,
        locale: "tr",
      },
    });
    expect(response.status()).toBe(201);
  }
});

test.afterAll(async ({ request }) => {
  const origin =
    "http://" +
    (process.env.EVERYOS_E2E_HTTP_HOST ?? "127.0.0.1") +
    ":" +
    (process.env.EVERYOS_E2E_PORT ?? "7480");
  const login = await request.post("/api/auth/login", {
    headers: { Origin: origin },
    data: { username: "goktug", password: PASSWORD },
  });
  expect(login.status()).toBe(200);
  const { session } = (await login.json()) as { session: SessionInfo };
  const headers = { Origin: origin, [CSRF_HEADER]: session.csrfToken };
  const listing = (await (
    await request.get("/api/files/list?root=dev&path=&hidden=true")
  ).json()) as { entries: Array<{ name: string }> };
  const paths = listing.entries
    .map((e) => e.name)
    .filter((name) => ["network-phone.txt", "Phone uploads"].includes(name));
  if (paths.length)
    expect(
      (
        await request.post("/api/files/delete", {
          headers,
          data: { root: "dev", paths, confirm: true },
        })
      ).status(),
    ).toBe(204);
  const sharing = (await (await request.get("/api/sharing")).json()) as {
    connections: Array<{ id: string; name: string }>;
    quickShares: Array<{ id: string; name: string }>;
  };
  for (const c of sharing.connections.filter((c) => c.name === "Native UI fixture"))
    expect(
      (
        await request.delete("/api/sharing/connections/" + c.id, {
          headers,
          data: { confirm: true },
        })
      ).status(),
    ).toBe(204);
  for (const q of sharing.quickShares.filter((q) =>
    ["network-phone.txt", "Phone video"].includes(q.name),
  ))
    expect(
      (
        await request.delete("/api/sharing/quick/" + q.id, { headers, data: { confirm: true } })
      ).status(),
    ).toBe(204);
});

async function mutate(
  page: Page,
  session: SessionInfo,
  path: string,
  body: unknown,
  method = "POST",
) {
  return page.evaluate(
    async ({ path, body, method, header, token }) => {
      const r = await fetch("/api" + path, {
        method,
        headers: { "Content-Type": "application/json", [header]: token },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json().catch(() => null)) as unknown };
    },
    { path, body, method, header: CSRF_HEADER, token: session.csrfToken },
  );
}
async function files(page: Page) {
  const mobile = page.getByTestId("mobile-shell");
  if (await mobile.isVisible()) {
    await mobile.getByRole("button", { name: "Dosyalar", exact: true }).click();
    await expect(mobile.getByTestId("files-app")).toBeVisible();
    return mobile;
  }
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("dosyalar");
  await page.keyboard.press("Enter");
  const app = page.locator('[data-app-id="everyos.files"]');
  await expect(app.getByTestId("files-app")).toBeVisible();
  return app;
}

test("Files creates a QR share and an account-free phone browser downloads its real bytes", async ({
  page,
  browser,
}) => {
  const session = await signIn(page);
  expect(
    (
      await mutate(
        page,
        session,
        "/files/text",
        {
          root: "dev",
          path: "network-phone.txt",
          content: "EveryOS real browser transfer\n",
          etag: null,
        },
        "PUT",
      )
    ).status,
  ).toBe(200);
  const app = await files(page);
  await app.getByTestId("files-sidebar").getByRole("button", { name: "Development files" }).click();
  const row = app
    .getByTestId("file-row")
    .filter({ has: page.getByText("network-phone.txt", { exact: true }) });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Quick Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dosya gönder" });
  await dialog.getByLabel("Parola · İsteğe bağlı").fill("phone-share-password");
  await dialog.getByRole("button", { name: "Bağlantı oluştur", exact: true }).click();
  await expect(dialog.getByRole("img", { name: "Quick Share" })).toBeVisible({ timeout: 15000 });
  const url = await dialog.getByLabel("Bağlantıyı kopyala").inputValue();
  expect(url).toMatch(/\/share#[A-Za-z0-9_-]{43}$/);
  await page.screenshot({
    path: test.info().outputPath("quick-share-qr.png"),
    animations: "disabled",
  });
  const phone = await browser.newContext({
    viewport: { width: 375, height: 812 },
    locale: "tr-TR",
  });
  try {
    const guest = await phone.newPage();
    await guest.goto(url);
    await guest.getByLabel("Parola · İsteğe bağlı").fill("phone-share-password");
    await guest.getByRole("button", { name: "Aç", exact: true }).click();
    await expect(guest.getByRole("link", { name: /network-phone.txt/ })).toBeVisible();
    expect(
      await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await guest.screenshot({
      path: test.info().outputPath("phone-download.png"),
      animations: "disabled",
    });
    const download = guest.waitForEvent("download");
    await guest.getByRole("link", { name: /network-phone.txt/ }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("network-phone.txt");
    expect(await readFile(await saved.path(), "utf8")).toBe("EveryOS real browser transfer\n");
    expect((await guest.request.get("/api/auth/session")).status()).toBe(401);
  } finally {
    await phone.close();
  }
});

test("a phone uploads a video into the selected folder and sees revocation", async ({
  page,
  browser,
}) => {
  const session = await signIn(page);
  expect(
    (await mutate(page, session, "/files/mkdir", { root: "dev", path: "", name: "Phone uploads" }))
      .status,
  ).toBe(201);
  const created = await mutate(page, session, "/sharing/quick", {
    name: "Phone video",
    direction: "receive",
    root: "dev",
    path: "Phone uploads",
    paths: [],
    lifetimeMinutes: 15,
    oneTime: false,
    maxDownloads: 10,
    maxBytes: 16 * 1024 ** 2,
  });
  expect(created.status).toBe(201);
  const { url, share } = created.body as { url: string; share: { id: string } };
  const phone = await browser.newContext({
    viewport: { width: 375, height: 812 },
    locale: "tr-TR",
  });
  try {
    const guest = await phone.newPage();
    await guest.goto(url);
    await guest.getByRole("button", { name: "Aç", exact: true }).click();
    const video = join(import.meta.dirname, "fixtures/media/demo.mp4");
    await guest.locator('input[type="file"]').setInputFiles(video);
    await expect(guest.getByRole("status").filter({ hasText: "Dosyalar yüklendi." })).toBeVisible();
    const response = await page.request.get(
      "/api/files/download?root=dev&path=Phone%20uploads%2Fdemo.mp4",
    );
    expect(response.status()).toBe(200);
    expect(await response.body()).toEqual(await readFile(video));
    expect(
      await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await guest.screenshot({
      path: test.info().outputPath("phone-video-upload.png"),
      animations: "disabled",
    });
    const revoked = await mutate(
      page,
      session,
      "/sharing/quick/" + share.id,
      { confirm: true },
      "DELETE",
    );
    expect(revoked.status).toBe(204);
    expect((await guest.request.get("/api/quick-share/" + share.id)).status()).toBe(410);
  } finally {
    await phone.close();
  }
});

test("Network integrates into Files and Settings with explicit native simulation and working forms", async ({
  page,
}) => {
  await page.route("**/api/sharing", async (route) => {
    const response = await route.fetch(),
      overview = (await response.json()) as SharingOverview;
    overview.privateNetworks = overview.privateNetworks.map((node) =>
      node.provider === "netbird" ? { ...node, installed: true, state: "needs-login" } : node,
    );
    await route.fulfill({ response, json: overview });
  });
  await signIn(page);
  const app = await files(page);
  await app.getByTestId("files-network").click();
  const network = app.getByTestId("network-sharing");
  await expect(network).toBeVisible();
  await expect(network).toContainText("Simüle");
  await network.getByRole("button", { name: "Bağlantı ekle", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Bağlantı ekle" });
  await dialog.getByLabel("Ad", { exact: true }).fill("Native UI fixture");
  await dialog.getByLabel("Sunucu", { exact: true }).fill("192.0.2.25");
  await dialog.getByLabel("Uzak klasör / paylaşım", { exact: true }).fill("/data");
  await dialog.getByLabel("Bağlama klasörü adı (isteğe bağlı)").fill("research");
  await dialog.getByRole("button", { name: "Kaydet", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(network).toContainText("Native UI fixture");
  await network.getByRole("tab", { name: "Ayarlar", exact: true }).click();
  await expect(network).toContainText("Tailscale");
  await expect(network).toContainText("NetBird");
  await expect(network).toContainText("Kayıt gerekiyor");
  await network.getByRole("button", { name: "Samba hesabı", exact: true }).click();
  const samba = page.getByRole("dialog", { name: "Samba hesabı" });
  await samba.getByLabel("Kullanıcı adı", { exact: true }).fill("fixture");
  await samba.getByLabel("Parola", { exact: true }).fill("fixture-password-42");
  await samba.getByRole("button", { name: "Kaydet", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Vazgeç", exact: true }).click();
  await expect(samba).toBeVisible(); // Cancelling consent must not close the credential form.
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: test.info().outputPath("network-settings.png"),
    animations: "disabled",
  });
});

test("Network management and connection forms fit a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);
  const app = await files(page);
  await app.getByRole("button", { name: "Ağ paylaşımı", exact: true }).click();
  const network = app.getByTestId("network-sharing");
  await expect(network).toBeVisible();
  const tab = network.getByRole("tab", { name: "Bağlantılar", exact: true });
  await tab.focus();
  await page.keyboard.press("End");
  await expect(network.getByRole("tab", { name: "Ayarlar", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Home");
  await expect(network.getByRole("tab", { name: "Genel bakış", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await network.getByRole("button", { name: "Bağlantı ekle", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Bağlantı ekle" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.getBoundingClientRect().width <= window.innerWidth)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath("phone-network-form.png"),
    animations: "disabled",
  });
});
