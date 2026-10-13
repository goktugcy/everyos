import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import { once } from "node:events";
import { PASSWORD, signIn } from "./helpers.ts";

test("connection text shows live safe metadata and clears it when closed or locked", async ({
  page,
}) => {
  const session = await signIn(page);
  const trigger = page.getByTestId("connection-status");
  await expect(trigger).toHaveText("Şifresiz");
  await expect(trigger.locator("svg")).toHaveCount(0);
  const connectionRect = await trigger.boundingBox();
  const pulseRect = await page.getByTestId("pulse-trigger").boundingBox();
  expect(connectionRect!.x + connectionRect!.width).toBeLessThan(pulseRect!.x);
  await trigger.click();
  const panel = page.getByTestId("connection-info");
  await expect(panel).toContainText("HTTP verileri şifrelemez");
  await expect(panel).toContainText("Tailscale");
  const entry = panel.locator("[data-traffic-entry]").first();
  // The real trash poll completes through the API client; diagnostics issue no probe requests.
  await expect(entry).toContainText("GET", { timeout: 15_000 });
  await expect(entry).toContainText("Durum 200");
  await expect(entry).toContainText("ms");
  await expect(entry).toContainText(/Alınan \d/);
  await expect(panel).not.toContainText(session.csrfToken);
  await expect(panel).not.toContainText(PASSWORD);
  await page.screenshot({
    path: test.info().outputPath("connection-info.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await trigger.click();
  await expect(panel).toContainText("Yeni bir isteğin tamamlanması bekleniyor");
  await page.keyboard.press("Control+Alt+l");
  await expect(panel).toHaveCount(0);
  await page.getByLabel("Parola", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Kilidi aç", exact: true }).click();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(panel).toContainText("Yeni bir isteğin tamamlanması bekleniyor");
});

test("HTTPS connection text reflects the real browser hop behind an HTTP test proxy", async ({
  page,
  browser,
  baseURL,
}) => {
  await signIn(page);
  const key = test.info().outputPath("fixture-key.pem");
  const cert = test.info().outputPath("fixture-cert.pem");
  // This disposable certificate is unrelated to the release publisher key.
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  const proxy = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (incoming, outgoing) => {
      const target = new URL(incoming.url ?? "/", baseURL);
      const upstream = request(
        target,
        { method: incoming.method, headers: { ...incoming.headers, host: target.host } },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      outgoing.on("close", () => upstream.destroy());
      incoming.pipe(upstream);
    },
  );
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing TLS fixture port");
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies(await page.context().cookies());
    const securePage = await context.newPage();
    await securePage.goto(`https://127.0.0.1:${address.port}`);
    await expect(securePage.getByTestId("desktop")).toBeVisible();
    const trigger = securePage.getByTestId("connection-status");
    await expect(trigger).toHaveText("Şifreli");
    await trigger.click();
    const panel = securePage.getByTestId("connection-info");
    await expect(panel).toContainText("HTTPS / TLS");
    await expect(panel.locator("[data-traffic-entry]").first()).toContainText("Durum 200", {
      timeout: 15_000,
    });
    await securePage.screenshot({
      path: test.info().outputPath("connection-https.png"),
      animations: "disabled",
    });
  } finally {
    await context.close();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
