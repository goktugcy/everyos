import { expect, test, type Page } from "@playwright/test";
import { CSRF_HEADER, type NotificationCounts } from "../../packages/shared/src/index.ts";
import { signIn } from "./helpers.ts";

/** Five wrong passwords for one (non-existent) account lock it and notify administrators. */
async function lockOut(page: Page, username: string) {
  for (let i = 0; i < 5; i++) {
    await page.request.post("/api/auth/login", {
      data: { username, password: "definitely-wrong-password" },
      headers: { Origin: new URL(page.url()).origin },
    });
  }
}

async function unread(page: Page): Promise<NotificationCounts> {
  return (
    (await (await page.request.get("/api/notifications")).json()) as { unread: NotificationCounts }
  ).unread;
}

const total = (counts: NotificationCounts, without: string[] = []) =>
  Object.entries(counts).reduce(
    (sum, [category, n]) => (without.includes(category) ? sum : sum + (n ?? 0)),
    0,
  );

// The host monitor also reports the simulator's failed service and unhealthy container
// (real behaviour); assertions therefore look at the security category and toast texts.
test("security notifications pop up, are counted, read, muted and cleared per user", async ({
  page,
}) => {
  const session = await signIn(page, true, { toasts: true });
  const headers = { [CSRF_HEADER]: session.csrfToken };
  expect(
    (await page.request.post("/api/notifications/read", { headers, data: { all: true } })).status(),
  ).toBe(200);
  const bell = page.getByTestId("notification-bell");
  await expect(bell).toBeVisible();

  await lockOut(page, "e2e-ghost-one");
  const toast = page.getByTestId("notification-toast").filter({ hasText: "e2e-ghost-one" });
  await expect(toast).toContainText("Giriş denemeleri engellendi");
  await expect.poll(async () => (await unread(page)).security).toBe(1);
  await expect.poll(async () => (await bell.getAttribute("aria-label")) ?? "").toMatch(/okunmamış/);

  await bell.click();
  const center = page.getByTestId("notification-center");
  const item = center.getByTestId("notification").filter({ hasText: "e2e-ghost-one" });
  await expect(item).toBeVisible();
  await center.getByRole("button", { name: "Tümünü okundu işaretle" }).click();
  await expect.poll(async () => (await unread(page)).security ?? 0).toBe(0);
  await center.getByRole("radio", { name: "Okunmamış" }).click();
  await expect(item).toHaveCount(0);
  await center.getByRole("radio", { name: "Tümü" }).click();
  await expect(item).toBeVisible();

  // Muting a category: still listed, but no pop-up and no badge.
  await center.getByRole("button", { name: "Bildirim ayarları" }).click();
  const settings = page.locator('[data-app-id="otuken.settings"]');
  await settings.getByRole("switch", { name: "Güvenlik bildirimleri" }).click();
  await expect
    .poll(async () => {
      const body = (await (await page.request.get("/api/preferences")).json()) as {
        preferences: { notifications?: { mutedCategories: string[] } };
      };
      return body.preferences.notifications?.mutedCategories;
    })
    .toEqual(["security"]);
  await lockOut(page, "e2e-ghost-two");
  await expect.poll(async () => (await unread(page)).security).toBe(1);
  await page.waitForTimeout(500);
  await expect(
    page.getByTestId("notification-toast").filter({ hasText: "e2e-ghost-two" }),
  ).toHaveCount(0);
  // The badge counts everything except the muted category.
  await expect
    .poll(async () => {
      const expected = total(await unread(page), ["security"]);
      return (
        (await bell.getAttribute("aria-label")) ===
        (expected > 0 ? `Bildirimler (${expected} okunmamış)` : "Bildirimler")
      );
    })
    .toBe(true);

  await bell.click();
  await center.getByLabel("Kategori", { exact: true }).selectOption("security");
  await expect(center.getByTestId("notification")).toHaveCount(2);
  await center.getByRole("button", { name: "Tümünü temizle" }).click();
  await expect(center).toContainText("Bildirim yok.");
  await page.reload();
  await page.getByTestId("notification-bell").click();
  await page
    .getByTestId("notification-center")
    .getByLabel("Kategori", { exact: true })
    .selectOption("security");
  await expect(page.getByTestId("notification-center")).toContainText("Bildirim yok.");
});
