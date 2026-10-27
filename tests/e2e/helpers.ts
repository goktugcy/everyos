import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import {
  CSRF_HEADER,
  type LoginResponse,
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
  // Reset before mounting: restored windows and lock-on-hide preferences can otherwise act on
  // this new session while the fixture navigates away. Foundation tests exercise the login UI.
  // Browser fetch also honors EVERYOS_E2E_HTTP_HOST, unlike Node's APIRequestContext.
  await page.goto("/api/health");
  const login = await page.evaluate(async (password) => {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "goktug", password }),
    });
    return { status: response.status, body: (await response.json()) as LoginResponse };
  }, PASSWORD);
  expect(login.status).toBe(200);
  expect(login.body.status).toBe("authenticated");
  if (login.body.status !== "authenticated") throw new Error("Fixture login did not authenticate");
  const session = login.body.session;
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
