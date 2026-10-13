import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  CSRF_HEADER,
  type NotificationView,
  type SelfUpdateStatus,
} from "../../packages/shared/src/index.ts";
import { signIn } from "./helpers.ts";

async function visibility(page: Page, state: "visible" | "hidden") {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test("hidden bell keeps live notifications and missed version notices recover once without reload", async ({
  page,
}) => {
  const session = await signIn(page, true, { toasts: true });
  try {
    const bar = page.getByTestId("menubar");
    await bar.click({ button: "right", position: { x: 230, y: 18 } });
    await page.getByRole("menuitem", { name: "Gösterilecek öğeler", exact: true }).hover();
    await page.getByRole("menuitemcheckbox", { name: "Bildirimler", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("notification-bell")).toHaveCount(0);
    for (let i = 0; i < 5; i++)
      await page.request.post("/api/auth/login", {
        data: { username: "live-release-ghost", password: "definitely-wrong-password" },
        headers: { Origin: new URL(page.url()).origin },
      });
    await expect(
      page.getByTestId("notification-toast").filter({ hasText: "live-release-ghost" }),
    ).toBeVisible();

    // Only release discovery is a fixture; the previous live notification used the real API/SSE.
    const notice: NotificationView = {
      id: randomUUID(),
      kind: "everyos-update-available",
      category: "updates",
      severity: "warning",
      params: { version: "9.9.9", installedVersion: "0.1.0" },
      count: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      resolvedAt: null,
      read: false,
    };
    await visibility(page, "hidden");
    await page.route("**/api/events?**", (route) => route.abort());
    let delayed: (() => void) | null = null;
    let holdNotice = true;
    await page.route("**/api/notifications?**", async (route) => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get("category") !== "updates" || query.get("unread") !== "true")
        return route.continue();
      if (holdNotice)
        await new Promise<void>((resolve) => {
          delayed = resolve;
        });
      return route.fulfill({
        json: { notifications: [notice], nextCursor: null, unread: { updates: 1 } },
      });
    });
    await visibility(page, "visible");
    await expect.poll(() => delayed !== null).toBe(true);
    await visibility(page, "hidden");
    holdNotice = false;
    const response = page.waitForResponse((r) =>
      r.url().includes("/api/notifications?category=updates&unread=true"),
    );
    (delayed as (() => void) | null)?.();
    await response;
    await page.waitForTimeout(100);
    const toast = page.getByTestId("notification-toast").filter({ hasText: "9.9.9" });
    await expect(toast).toHaveCount(0);
    await visibility(page, "visible");
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Kapat", exact: true }).click();
    await visibility(page, "hidden");
    await visibility(page, "visible");
    await page.waitForTimeout(300);
    await expect(toast).toHaveCount(0);
  } finally {
    const records = (await (
      await page.request.get("/api/notifications?category=security&limit=200")
    ).json()) as { notifications: NotificationView[] };
    const ids = records.notifications
      .filter((notice) => notice.params.username === "live-release-ghost")
      .map((notice) => notice.id);
    if (ids.length)
      await page.request.post("/api/notifications/dismiss", {
        headers: { [CSRF_HEADER]: session.csrfToken },
        data: { ids },
      });
  }
});

test("release events update About immediately and stale reads cannot restore an older version", async ({
  page,
}) => {
  await signIn(page);
  const original = (await (await page.request.get("/api/self-update")).json()) as SelfUpdateStatus;
  let snapshot: SelfUpdateStatus = {
    ...original,
    configured: true,
    reason: null,
    checkedAt: Date.now(),
    available: null,
  };
  const pending: Array<() => void> = [];
  // Discovery/status fixtures allow a real browser stream test without installing on the host.
  await page.route("**/api/self-update", async (route) => {
    const captured = structuredClone(snapshot);
    await new Promise<void>((resolve) => pending.push(resolve));
    await route.fulfill({ json: captured }).catch(() => undefined);
  });
  await page.route("**/api/events?**", (route) => {
    const topics = new URL(route.request().url()).searchParams.get("topics")?.split(",") ?? [];
    return topics.includes("release")
      ? route.fulfill({
          contentType: "text/event-stream",
          body: `event: ready\ndata: {}\n\nevent: release.status\ndata: ${JSON.stringify(snapshot)}\n\n`,
        })
      : route.continue();
  });
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  try {
    await page.getByTestId("dock").getByRole("button", { name: "Ayarlar", exact: true }).click();
    const settings = page.locator('[data-app-id="everyos.settings"]');
    await settings.getByRole("button", { name: "Hakkında", exact: true }).click();
    const panel = settings.getByTestId("self-update-panel");
    await expect(panel.locator("dd").first()).toHaveText(original.installedVersion);
    snapshot = {
      ...snapshot,
      checkedAt: Date.now() + 1,
      available: {
        version: "9.9.9",
        minVersion: "0.1.0",
        schemaVersion: 1,
        notes: "Live release discovery fixture",
        publishedAt: Date.now(),
      },
    };
    await visibility(page, "hidden");
    await visibility(page, "visible");
    await expect(panel.locator("dd").nth(1)).toHaveText("9.9.9");
    for (const resolve of pending.splice(0)) resolve();
    await page.waitForTimeout(300);
    await expect(panel.locator("dd").nth(1)).toHaveText("9.9.9");
    await expect(
      panel.getByRole("button", { name: "Güncellemeyi yükle", exact: true }),
    ).toBeEnabled();
    snapshot = { ...snapshot, installedVersion: "9.9.9", available: null };
    await visibility(page, "hidden");
    await visibility(page, "visible");
    await expect(panel.locator("dd").first()).toHaveText("9.9.9");
    await expect(panel.locator("dd").nth(1)).toHaveText("—");
    expect(navigations).toBe(0);
  } finally {
    for (const resolve of pending) resolve();
  }
});
