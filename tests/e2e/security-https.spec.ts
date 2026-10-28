import { readFileSync } from "node:fs";
import { request } from "node:https";
import { once } from "node:events";
import { createServer } from "node:net";
import { expect, test } from "@playwright/test";
import { CSRF_HEADER, type HttpsView, type SessionInfo } from "../../packages/shared/src/index.ts";
import { signIn } from "./helpers.ts";

/** Keep the candidate out of the default outbound ephemeral range and reserve it until use. */
async function reservePort() {
  for (let port = 20_000; port < 30_000; port++) {
    const server = createServer();
    server.listen(port, "127.0.0.1");
    try {
      await once(server, "listening");
      return {
        port,
        release: () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("No available port for the owned HTTPS test listener");
}

test.afterEach(async ({ page }) => {
  const sessionResponse = await page.request.get("/api/auth/session");
  if (!sessionResponse.ok()) return;
  const session = (await sessionResponse.json()) as SessionInfo;
  const response = await page.request.get("/api/https");
  expect(response.ok()).toBe(true);
  const { lan } = (await response.json()) as HttpsView;
  const disabled = await page.request.put("/api/https/lan", {
    headers: { [CSRF_HEADER]: session.csrfToken, Origin: new URL(page.url()).origin },
    data: { enabled: false, port: lan.port },
  });
  expect(disabled.status()).toBe(200);
});

/** A GET over HTTPS that trusts only `ca`. */
function get(url: string, ca: string) {
  return new Promise<number>((resolve, reject) => {
    const req = request(url, { ca, agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("HTTPS settings: Tailscale Serve and the local-network listener with EveryOS's authority", async ({
  page,
}) => {
  await signIn(page);
  await page.getByTestId("dock").getByRole("button", { name: "Ayarlar", exact: true }).click();
  const settings = page.locator('[data-app-id="everyos.settings"]');
  await settings.getByRole("button", { name: "Güvenlik", exact: true }).click();
  const group = settings.getByRole("region", { name: "HTTPS" });

  // A development agent never changes the developer's Tailscale; the refusal is shown.
  const tailscale = group.getByTestId("https-tailscale");
  await tailscale.getByRole("button", { name: "Tailscale ile aç" }).click();
  await expect(tailscale).toContainText("güvenlik politikası tarafından reddedildi");

  const lan = group.getByTestId("https-lan");
  const reservation = await reservePort();
  const port = String(reservation.port);
  try {
    await lan.getByLabel("HTTPS bağlantı noktası").fill(port);
  } finally {
    await reservation.release();
  }
  await lan.getByRole("switch", { name: "Yerel ağda HTTPS" }).click();
  await expect(lan).toContainText("Adresler");
  await expect(lan).toContainText("Sertifika yetkilisi");
  // The test stack listens on loopback only, which the panel points out.
  await expect(lan).toContainText("yalnızca bu cihazın içinden");
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    lan.getByRole("button", { name: "Yetkili sertifikasını indir" }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^everyos-.*-ca\.crt$/);
  const ca = readFileSync(await file.path(), "utf8");
  expect(ca).toContain("BEGIN CERTIFICATE");
  expect(await get(`https://127.0.0.1:${port}/api/health`, ca)).toBe(200);

  await lan.getByRole("switch", { name: "Yerel ağda HTTPS" }).click();
  await expect(lan).not.toContainText("Sertifika yetkilisi");
  await expect(get(`https://127.0.0.1:${port}/api/health`, ca)).rejects.toThrow();
});
