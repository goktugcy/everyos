import { expect, request, test } from "@playwright/test";
import { generateTotp } from "../../packages/auth/src/index.ts";
import {
  CSRF_HEADER,
  type AdminUserView,
  type LoginResponse,
  type TotpEnrollmentResponse,
} from "../../packages/shared/src/index.ts";
import { PASSWORD, signIn } from "./helpers.ts";

test("required two-factor authentication keeps covered accounts on its setup until done", async ({
  page,
  baseURL,
}) => {
  const session = await signIn(page);
  const headers = { [CSRF_HEADER]: session.csrfToken };
  const create = async (username: string, role: "admin" | "viewer") => {
    const response = await page.request.post("/api/users", {
      headers,
      data: { username, displayName: username, password: PASSWORD, role },
    });
    expect(response.status()).toBe(201);
    return (await response.json()) as AdminUserView;
  };
  const warden = await create("warden", "admin");
  const family = await create("family", "viewer");

  // Without a second factor of their own, the administrator cannot require one from admins.
  await page.getByTestId("dock").getByRole("button", { name: "Ayarlar", exact: true }).click();
  const settings = page.locator('[data-app-id="everyos.settings"]');
  await settings.getByRole("button", { name: "Güvenlik", exact: true }).click();
  await settings
    .getByRole("combobox", { name: "İki adımlı doğrulama zorunluluğu" })
    .selectOption("admins");
  await expect(settings).toContainText(
    "Bunu zorunlu tutmadan önce kendi hesabında iki adımlı doğrulamayı kur.",
  );

  // Another administrator with two-factor authentication requires it from everyone.
  const wardenApi = await request.newContext({ baseURL: baseURL! });
  const login = (await (
    await wardenApi.post("/api/auth/login", { data: { username: "warden", password: PASSWORD } })
  ).json()) as LoginResponse;
  if (login.status !== "authenticated") throw new Error("warden has no second factor yet");
  const wardenHeaders = { [CSRF_HEADER]: login.session.csrfToken };
  const policy = (required: string) =>
    wardenApi.put("/api/security/two-factor", { headers: wardenHeaders, data: { required } });
  try {
    const enrollment = (await (
      await wardenApi.post("/api/account/totp/enroll", { headers: wardenHeaders })
    ).json()) as TotpEnrollmentResponse;
    expect(
      (
        await wardenApi.post("/api/account/totp/enable", {
          headers: wardenHeaders,
          data: { code: generateTotp(enrollment.secret, Date.now()) },
        })
      ).status(),
    ).toBe(200);
    expect((await policy("everyone")).status()).toBe(200);

    // The first administrator, still without one, only sees the setup now.
    await page.reload();
    await expect(page.getByTestId("two-factor-setup")).toBeVisible();
    await expect(page.getByTestId("desktop")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "İki adımlı doğrulamayı kur" })).toBeVisible();
    await page.getByRole("button", { name: "Oturumu kapat" }).click();

    // A family member signs in, sets it up and reaches the desktop.
    await page.getByLabel("Kullanıcı adı").fill("family");
    await page.getByLabel(/^Parola$/).fill(PASSWORD);
    await page.getByRole("button", { name: "Giriş yap" }).click();
    const setup = page.getByTestId("two-factor-setup");
    await expect(setup).toBeVisible();
    await setup.getByRole("button", { name: "Etkinleştir" }).click();
    const secret = (await setup.locator("code").first().innerText()).trim();
    await setup
      .getByLabel("Uygulamada görünen kodu girerek onaylayın")
      .fill(generateTotp(secret, Date.now()));
    await setup.getByRole("button", { name: "Onayla ve etkinleştir" }).click();
    await setup.getByRole("button", { name: "Kodları kaydettim" }).click();
    await expect(page.getByTestId("desktop")).toBeVisible();
    await expect(page.getByTestId("two-factor-setup")).toHaveCount(0);
  } finally {
    expect((await policy("nobody")).status()).toBe(200);
    await wardenApi.dispose();
  }

  // Back to normal for the first administrator; the test accounts go away.
  await page.context().clearCookies();
  const again = await signIn(page);
  for (const id of [family.id, warden.id])
    expect(
      (
        await page.request.delete(`/api/users/${id}`, {
          headers: { [CSRF_HEADER]: again.csrfToken },
        })
      ).status(),
    ).toBe(204);
});
