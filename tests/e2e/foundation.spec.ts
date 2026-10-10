import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const stateDir = join(dirname(fileURLToPath(import.meta.url)), ".state");
const PASSWORD = "mavi-gokyuzu-ve-daglar-42";

test.describe.configure({ mode: "serial" });

test("first-run setup creates the administrator and opens the shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Otuken'e hoş geldiniz" })).toBeVisible();

  // Turkish is preselected; continue to token verification.
  await expect(page.getByRole("radio", { name: "Türkçe" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Devam et" }).click();

  const token = readFileSync(join(stateDir, "data/setup-token"), "utf8").trim();
  await page.getByLabel("Kurulum anahtarı").fill("yanlis-anahtar");
  await page.getByRole("button", { name: "Devam et" }).click();

  await page.getByLabel("Kullanıcı adı").fill("goktug");
  await page.getByLabel("Görünen ad").fill("Göktuğ");
  await page.getByLabel("Parola", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Parola (tekrar)").fill(PASSWORD);
  await page.getByRole("button", { name: "Kurulumu tamamla" }).click();

  // A wrong token sends the user back to the verification step with an error.
  await expect(page.getByText("Kurulum anahtarı hatalı.")).toBeVisible();
  await page.getByLabel("Kurulum anahtarı").fill(token);
  await page.getByRole("button", { name: "Devam et" }).click();
  await page.getByRole("button", { name: "Kurulumu tamamla" }).click();

  await expect(page.getByRole("heading", { name: "Hoş geldin, Göktuğ" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sistem" })).toBeVisible();
  await expect(page.getByText("Gerçek veri")).toBeVisible();
  await expect(page.getByText("Ajan bağlı")).toBeVisible();
});

test("sign out and sign back in, switching the language", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Oturum açın" })).toBeVisible();

  await page.getByLabel("Kullanıcı adı").fill("goktug");
  await page.getByLabel("Parola", { exact: true }).fill("yanlis-parola-123");
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page.getByText("Kullanıcı adı veya parola hatalı.")).toBeVisible();

  await page.getByLabel("Parola", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page.getByRole("heading", { name: "Hoş geldin, Göktuğ" })).toBeVisible();

  // Switch to English; the preference is saved to the account.
  await page.getByRole("button", { name: "Dil" }).click();
  await page.getByRole("menuitemradio", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, Göktuğ" })).toBeVisible();

  await page.getByRole("button", { name: "User menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  // The saved preference is applied after the next sign-in, too.
  await page.getByLabel("Username").fill("goktug");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, Göktuğ" })).toBeVisible();
});

test("session survives a page reload and the API rejects cross-site requests", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByLabel(/Kullanıcı adı|Username/).fill("goktug");
  await page.getByLabel(/^(Parola|Password)$/).fill(PASSWORD);
  await page.getByRole("button", { name: /Giriş yap|Sign in/ }).click();
  await expect(page.getByRole("heading", { name: /Hoş geldin|Welcome/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: /Hoş geldin|Welcome/ })).toBeVisible();

  const crossSite = await request.post("/api/auth/login", {
    headers: { origin: "https://evil.example" },
    data: { username: "goktug", password: PASSWORD },
  });
  expect(crossSite.status()).toBe(403);
});
