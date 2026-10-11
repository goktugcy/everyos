import { expect, test, type Page } from "@playwright/test";
import {
  CSRF_HEADER,
  type SessionInfo,
  type TerminalSessionView,
} from "../../packages/shared/src/index.ts";
import { PASSWORD, preferences, signIn } from "./helpers.ts";

async function openTerminal(page: Page) {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("terminal");
  await page.getByRole("option", { name: "Terminal", exact: true }).click();
  const app = page.locator('[data-app-id="otuken.terminal"]').last();
  await expect(app.getByTestId("terminal-app")).toHaveAttribute("data-terminal-phase", "connected");
  return app;
}
async function sessions(page: Page): Promise<TerminalSessionView[]> {
  const response = await page.request.get("/api/terminal/sessions");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { sessions: TerminalSessionView[] }).sessions;
}

async function signInTerminal(page: Page) {
  const session = await signIn(page);
  // Resetting preferences reloads the desktop and can briefly restore a shell
  // from the previous test's layout. Remove that detached fixture before opening.
  for (const terminal of await sessions(page))
    if (terminal.userId === session.user.id)
      expect(
        (
          await page.request.delete(`/api/terminal/sessions/${terminal.id}`, {
            headers: { [CSRF_HEADER]: session.csrfToken },
          })
        ).status(),
      ).toBe(204);
  return session;
}

// Failed assertions must not consume another test's real PTY quota.
test.afterEach(async ({ page }) => {
  const auth = await page.request.get("/api/auth/session");
  if (auth.status() !== 200) return;
  const session = (await auth.json()) as SessionInfo;
  if (!session.permissions.includes("terminal:access")) return;
  for (const terminal of await sessions(page))
    expect(
      (
        await page.request.delete(`/api/terminal/sessions/${terminal.id}`, {
          headers: { [CSRF_HEADER]: session.csrfToken },
        })
      ).status(),
    ).toBe(204);
});

test("terminal runs a real shell, reloads the same session and closes it with the window", async ({
  page,
  context,
}) => {
  await signInTerminal(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const app = await openTerminal(page);
  const initial = await sessions(page);
  expect(initial).toHaveLength(1);
  const id = initial[0]!.id;
  await app.getByRole("textbox", { name: "Terminal girdisi" }).focus();
  // The output assertion matches a standalone line, not the echoed command.
  await page.keyboard.type("echo otuken-e2e");
  await page.keyboard.press("Enter");
  const output = app
    .locator(".xterm-accessibility-tree > div")
    .filter({ hasText: /^otuken-e2e\s*$/ });
  await expect(output).toHaveCount(1);
  await page.evaluate(() => navigator.clipboard.writeText("printf 'clipboard-ğ\\n'"));
  const modifier = await page.evaluate(() =>
    navigator.platform.includes("Mac") ? "Meta" : "Control",
  );
  await page.keyboard.press(`${modifier}+v`);
  await expect(app.locator(".xterm-accessibility-tree")).toContainText("clipboard-ğ");
  await page.keyboard.press("Enter");
  await expect(
    app.locator(".xterm-accessibility-tree > div").filter({ hasText: /^clipboard-ğ\s*$/ }),
  ).toHaveCount(1);

  // Wait for the desktop's debounced layout write before reloading.
  await expect
    .poll(async () =>
      (await preferences(page)).windows?.windows.some(
        (window) => window.appId === "otuken.terminal",
      ),
    )
    .toBe(true);
  await page.reload();
  const restored = page.locator('[data-app-id="otuken.terminal"]');
  await expect(restored.getByTestId("terminal-app")).toHaveAttribute(
    "data-terminal-phase",
    "connected",
  );
  await expect(restored).toContainText("Oturuma yeniden bağlandı");
  await expect(
    restored.locator(".xterm-accessibility-tree > div").filter({ hasText: /^otuken-e2e\s*$/ }),
  ).toHaveCount(1);
  expect((await sessions(page)).map((session) => session.id)).toEqual([id]);
  await restored.getByRole("textbox", { name: "Terminal girdisi" }).focus();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("combobox", { name: "Uygulama veya komut ara…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await restored.getByRole("textbox", { name: "Terminal girdisi" }).focus();
  await page.keyboard.press("Control+Alt+ArrowLeft");
  await expect(restored).toHaveAttribute("data-layout", "left");
  await page.screenshot({ path: test.info().outputPath("terminal.png") });
  await restored.getByRole("textbox", { name: "Terminal girdisi" }).focus();
  await page.keyboard.press("Control+Alt+w");
  await expect(restored).toHaveCount(0);
  await expect.poll(async () => (await sessions(page)).length).toBe(0);
  expect(errors).toEqual([]);
});

test("terminal supports multiple windows, seven themes and explicit restart after shell exit", async ({
  page,
}) => {
  await signInTerminal(page);
  const first = await openTerminal(page);
  await first.focus();
  const second = await openTerminal(page);
  await expect.poll(async () => (await sessions(page)).length).toBe(2);
  for (const theme of [
    "Liquid Dark",
    "Liquid Light",
    "Frost Blue",
    "Aurora",
    "Neon Night",
    "Graphite Glass",
    "Minimal Clear",
  ]) {
    await page.getByRole("button", { name: "Hızlı ayarlar", exact: true }).click();
    await page.getByRole("radio", { name: theme, exact: true }).click();
    await page.keyboard.press("Escape");
    await expect
      .poll(async () =>
        second.locator("[data-terminal-input]").evaluate((element) => {
          const token = getComputedStyle(element)
            .getPropertyValue("--otk-surface")
            .trim()
            .split(/\s+/)
            .join(", ");
          return [...element.querySelectorAll(".xterm *")].some(
            (child) => getComputedStyle(child).backgroundColor === `rgb(${token})`,
          );
        }),
      )
      .toBe(true);
  }
  await second.getByRole("textbox", { name: "Terminal girdisi" }).focus();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(second.getByTestId("terminal-app")).toHaveAttribute("data-terminal-phase", "ended");
  await expect(second).toContainText("Kabuk sona erdi.");
  await expect.poll(async () => (await sessions(page)).length).toBe(1);
  await second.getByRole("button", { name: "Yeni oturum başlat" }).click();
  await expect(second.getByTestId("terminal-app")).toHaveAttribute(
    "data-terminal-phase",
    "connected",
  );
  await expect.poll(async () => (await sessions(page)).length).toBe(2);
  while (await page.locator('[data-app-id="otuken.terminal"]').count())
    await page
      .locator('[data-app-id="otuken.terminal"]')
      .last()
      .getByRole("button", { name: "Kapat", exact: true })
      .click();
  await expect.poll(async () => (await sessions(page)).length).toBe(0);
});

test("detached sessions require confirmation before ending", async ({ page }) => {
  await signInTerminal(page);
  const app = await openTerminal(page);
  const detached = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(
          `${location.origin.replace(/^http/, "ws")}/api/terminal/ws?cols=80&rows=24`,
        );
        ws.onmessage = (event: MessageEvent<unknown>) => {
          if (typeof event.data !== "string") return;
          const message = JSON.parse(event.data) as { type: string; sessionId?: string };
          if (message.type === "ready" && message.sessionId) {
            ws.close();
            resolve(message.sessionId);
          }
        };
        ws.onerror = () => reject(new Error("Fixture socket failed"));
      }),
  );
  await expect
    .poll(async () => (await sessions(page)).find((session) => session.id === detached)?.attached)
    .toBe(false);
  await app.getByRole("button", { name: "Oturumlar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Oturumlar", exact: true });
  const row = dialog.getByTestId("terminal-session").filter({ hasText: "Bağlı değil" });
  await row.getByRole("button", { name: "Sonlandır", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Vazgeç" }).click();
  expect((await sessions(page)).some((session) => session.id === detached)).toBe(true);
  await row.getByRole("button", { name: "Sonlandır", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Sonlandır", exact: true })
    .click();
  await expect
    .poll(async () => (await sessions(page)).some((session) => session.id === detached))
    .toBe(false);
  await dialog.getByRole("button", { name: "Kapat", exact: true }).click();
  await app.getByRole("button", { name: "Kapat", exact: true }).click();
});

test("a viewer cannot discover or open the terminal, including the WebSocket", async ({ page }) => {
  const admin = await signInTerminal(page);
  const created = await page.request.post("/api/users", {
    headers: { [CSRF_HEADER]: admin.csrfToken },
    data: {
      username: "terminalviewer",
      displayName: "Terminal Viewer",
      password: PASSWORD,
      role: "viewer",
      locale: "tr",
    },
  });
  expect(created.status()).toBe(201);
  expect(
    (
      await page.request.post("/api/auth/logout", { headers: { [CSRF_HEADER]: admin.csrfToken } })
    ).status(),
  ).toBe(204);
  await page.goto("/");
  await page.getByLabel("Kullanıcı adı", { exact: true }).fill("terminalviewer");
  await page.getByLabel("Parola", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Giriş yap", exact: true }).click();
  await expect(page.getByTestId("desktop")).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("terminal");
  await expect(page.getByRole("option", { name: "Terminal", exact: true })).toHaveCount(0);
  expect((await page.request.get("/api/terminal/status")).status()).toBe(403);
  expect((await page.request.get("/api/terminal/sessions")).status()).toBe(403);
  const viewer = (await (await page.request.get("/api/auth/session")).json()) as SessionInfo;
  expect(
    (
      await page.request.delete("/api/terminal/sessions/8b2fd8b1-62ef-4ad4-a1cd-8d430e0d055f", {
        headers: { [CSRF_HEADER]: viewer.csrfToken },
      })
    ).status(),
  ).toBe(403);
  const opened = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(
          `${location.origin.replace(/^http/, "ws")}/api/terminal/ws?cols=80&rows=24`,
        );
        ws.onopen = () => {
          ws.close();
          resolve(true);
        };
        ws.onerror = () => resolve(false);
      }),
  );
  expect(opened).toBe(false);
  await expect(page.locator('[data-app-id="otuken.terminal"]')).toHaveCount(0);
});

test("disabled status explains every reason and configuration without opening a shell", async ({
  page,
}) => {
  await signInTerminal(page);
  for (const [reason, text] of [
    ["not-configured", "Terminal için bir sistem hesabı yapılandırılmamış."],
    ["user-missing", "Yapılandırılan sistem hesabı bulunamadı."],
    ["root-refused", "Yapılandırılan root hesabına izin verilmiyor."],
    ["python-missing", "PTY için gereken Python 3 yorumlayıcısı bulunamadı."],
  ]) {
    await page.route("**/api/terminal/status", (route) =>
      route.fulfill({ json: { enabled: false, reason } }),
    );
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("terminal");
    await page.getByRole("option", { name: "Terminal", exact: true }).click();
    const app = page.locator('[data-app-id="otuken.terminal"]');
    await expect(app.getByTestId("terminal-disabled")).toContainText(text!);
    await expect(app).toContainText("terminal.user");
    await expect(app.locator(".xterm")).toHaveCount(0);
    expect(await sessions(page)).toHaveLength(0);
    await app.getByRole("button", { name: "Kapat", exact: true }).click();
    await page.unroute("**/api/terminal/status");
  }
});

test("closing a restored terminal before status loads still ends its shell", async ({ page }) => {
  await signInTerminal(page);
  await openTerminal(page);
  await expect
    .poll(async () =>
      (await preferences(page)).windows?.windows.some(
        (window) => window.appId === "otuken.terminal",
      ),
    )
    .toBe(true);
  let requested = false;
  await page.route("**/api/terminal/status", () => {
    requested = true;
  });
  await page.reload();
  await expect.poll(() => requested).toBe(true);
  const app = page.locator('[data-app-id="otuken.terminal"]');
  await expect(app.getByRole("button", { name: "Kapat", exact: true })).toBeVisible();
  await expect(app.locator(".xterm")).toHaveCount(0);
  await app.getByRole("button", { name: "Kapat", exact: true }).click();
  await expect.poll(async () => (await sessions(page)).length).toBe(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
