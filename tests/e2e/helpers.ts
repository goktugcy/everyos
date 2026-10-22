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
  // EVERYOS_E2E_HTTP_HOST is mapped by Chromium, not Node's APIRequestContext.
  const session = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session");
    return (await response.json()) as SessionInfo;
  });
  expect(
    await page.evaluate(
      async ({ header, token }) =>
        (
          await fetch("/api/account", {
            method: "PATCH",
            headers: { "Content-Type": "application/json", [header]: token },
            body: JSON.stringify({ locale: "tr" }),
          })
        ).status,
      { header: CSRF_HEADER, token: session.csrfToken },
    ),
  ).toBe(200);
  if (reset) {
    // Unmount the desktop before resetting, while retaining an inert same-origin document.
    await page.goto("/api/health");
    const statuses = await page.evaluate(
      async ({ header, token, toasts }) => {
        const headers = { "Content-Type": "application/json", [header]: token };
        const statuses: number[] = [];
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
        ])
          statuses.push(
            (await fetch(`/api/preferences/${key}`, { method: "DELETE", headers })).status,
          );
        if (!toasts)
          statuses.push(
            (
              await fetch("/api/preferences/notifications", {
                method: "PUT",
                headers,
                body: JSON.stringify({
                  version: 1,
                  toasts: false,
                  toastMinSeverity: "warning",
                  mutedCategories: [],
                }),
              })
            ).status,
          );
        return statuses;
      },
      { header: CSRF_HEADER, token: session.csrfToken, toasts },
    );
    for (const status of statuses) expect(status).toBe(204);
  }
  await page.goto("/");
  await expect(page.locator('[data-testid="desktop"], [data-testid="mobile-shell"]')).toBeVisible();
  return session;
}

export async function preferences(page: Page): Promise<Partial<PreferenceDocuments>> {
  const body = await page.evaluate(
    async () =>
      (await (await fetch("/api/preferences")).json()) as {
        preferences: Partial<PreferenceDocuments>;
      },
  );
  return body.preferences;
}
