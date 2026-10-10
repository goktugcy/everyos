import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import {
  CSRF_HEADER,
  type PreferenceDocuments,
  type SessionInfo,
} from "../../packages/shared/src/index.ts";

export const stateDir = join(dirname(fileURLToPath(import.meta.url)), ".state");
export const PASSWORD = "mavi-gokyuzu-ve-daglar-42";

export async function signIn(page: Page, reset = true): Promise<SessionInfo> {
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
    for (const key of ["appearance", "desktop", "dock", "windows", "security", "menubar"]) {
      expect((await page.request.delete(`/api/preferences/${key}`, { headers })).status()).toBe(
        204,
      );
    }
  }
  await page.reload();
  await expect(page.locator('[data-testid="desktop"], [data-testid="mobile-shell"]')).toBeVisible();
  return session;
}

export async function preferences(page: Page): Promise<Partial<PreferenceDocuments>> {
  const body = (await (await page.request.get("/api/preferences")).json()) as {
    preferences: Partial<PreferenceDocuments>;
  };
  return body.preferences;
}
