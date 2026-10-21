import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import {
  CSRF_HEADER,
  type PreferenceDocuments,
  type SessionInfo,
} from "../../packages/shared/src/index.ts";

/** Throwaway stack state; `EVERYOS_E2E_STATE_DIR` lets two runs use separate directories. */
export const stateDir =
  process.env.EVERYOS_E2E_STATE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".state");
export const PASSWORD = "mavi-gokyuzu-ve-daglar-42";

/**
 * Signs in as the e2e administrator. With `reset`, preferences return to their
 * defaults, except that notification pop-ups stay off unless `toasts` is set:
 * the host monitor raises the simulator's critical conditions at a random
 * moment, and a persistent pop-up would cover whatever a test clicks next.
 */
export async function signIn(
  page: Page,
  reset = true,
  { toasts = false }: { toasts?: boolean } = {},
): Promise<SessionInfo> {
  await page.goto("/");
  await page.getByLabel(/Kullanıcı adı|Username/).fill("goktug");
  await page.getByLabel(/^(Parola|Password)$/).fill(PASSWORD);
  await page.getByRole("button", { name: /Giriş yap|Sign in/ }).click();
  await expect(page.locator('[data-testid="desktop"], [data-testid="mobile-shell"]')).toBeVisible();
  const session = (await (await page.request.get("/api/auth/session")).json()) as SessionInfo;
  const headers = { [CSRF_HEADER]: session.csrfToken };
  expect(
    (await page.request.patch("/api/account", { headers, data: { locale: "tr" } })).status(),
  ).toBe(200);
  if (reset) {
    // Leave the desktop first: it may still save the windows it restored, after the reset.
    await page.goto("about:blank");
    for (const key of [
      "appearance",
      "desktop",
      "dock",
      "windows",
      "security",
      "menubar",
      "widgets",
      "notifications",
      "pulse",
    ]) {
      expect((await page.request.delete(`/api/preferences/${key}`, { headers })).status()).toBe(
        204,
      );
    }
    if (!toasts)
      expect(
        (
          await page.request.put("/api/preferences/notifications", {
            headers,
            data: { version: 1, toasts: false, toastMinSeverity: "warning", mutedCategories: [] },
          })
        ).status(),
      ).toBe(204);
  }
  await page.goto("/");
  await expect(page.locator('[data-testid="desktop"], [data-testid="mobile-shell"]')).toBeVisible();
  return session;
}

export async function preferences(page: Page): Promise<Partial<PreferenceDocuments>> {
  const body = (await (await page.request.get("/api/preferences")).json()) as {
    preferences: Partial<PreferenceDocuments>;
  };
  return body.preferences;
}
