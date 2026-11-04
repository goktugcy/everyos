import { readFile, lstat, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type {
  LinuxBackupOverview,
  LinuxBackupInstallation,
} from "../../packages/shared/src/index.ts";
import { PASSWORD, signIn, stateDir } from "./helpers.ts";

test("built-in Linux backups encrypt and recover actual files without replacing the source", async ({
  page,
}) => {
  test.skip(
    !process.env.EVERYOS_TEST_BORG,
    "Requires a real Borg 1.x executable and an isolated source fixture",
  );
  test.setTimeout(180_000);
  await signIn(page);
  await page
    .getByTestId("dock")
    .getByRole("button", { name: "Tüm uygulamalar", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("Yedekler");
  await page.getByRole("option").filter({ hasText: "Yedekler" }).first().click();
  await page.getByRole("tab", { name: "Linux yedekleri", exact: true }).click();
  const app = page.getByTestId("linux-backups-app");
  await expect(
    app.getByText("Geliştirme ortamı: işlemler yalnızca test dosyalarında çalışır."),
  ).toBeVisible({ timeout: 15_000 });
  await app.getByRole("button", { name: "Yedekleme planı oluştur" }).click();
  const wizard = page.getByRole("dialog", { name: "Yedekleme planı oluştur" });
  await wizard.getByLabel("Plan adı", { exact: true }).fill("Encrypted Linux E2E");
  await wizard.getByRole("radio", { name: /Tüm sistem ve veriler/ }).check();
  await wizard.getByLabel("Hariç tutulacak yollar").fill("/home/excluded-fixture");
  await wizard.getByRole("button", { name: "Devam et" }).click();
  await wizard
    .getByLabel("Yedekleme parolası", { exact: true })
    .fill("E2E disposable backup phrase 2026");
  await wizard
    .getByLabel("Yedekleme parolasını tekrar yazın")
    .fill("E2E disposable backup phrase 2026");
  await wizard.getByRole("button", { name: "Devam et" }).click();
  await wizard.getByRole("button", { name: "Devam et" }).click();
  await expect(wizard.getByText("/proc", { exact: true })).toBeVisible();
  await wizard.getByLabel("Hesap parolanız").fill(PASSWORD);
  await wizard.screenshot({ path: test.info().outputPath("linux-backup-review.png") });
  await wizard.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(wizard).not.toBeVisible();
  const card = app.getByTestId("linux-backup-plan").filter({ hasText: "Encrypted Linux E2E" });
  await card.getByRole("button", { name: "Şimdi yedekle", exact: true }).click();
  const action = page.getByRole("dialog");
  await action.getByLabel("Hesap parolanız").fill(PASSWORD);
  await action.getByRole("button", { name: "İşlemi başlat" }).click();
  const overview = async (): Promise<LinuxBackupOverview> =>
    page.evaluate(
      async () =>
        (await (await fetch("/api/linux-backups")).json()) as Promise<LinuxBackupOverview>,
    );
  await expect
    .poll(async () => (await overview()).history.find((j) => j.kind === "create")?.status, {
      timeout: 90_000,
    })
    .toBe("succeeded");
  const devRoot = await realpath(stateDir);
  await writeFile(
    join(devRoot, "linux-backup-source/etc/backup-fixture"),
    "changed-after-capture\n",
  );
  await card.getByRole("button", { name: "Yedekler", exact: true }).click();
  await expect(card.getByText("Veri bütünlüğü doğrulanmış", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await card.getByRole("button", { name: "Bütünlüğü doğrula", exact: true }).click();
  await action.getByLabel("Hesap parolanız").fill(PASSWORD);
  await action.getByRole("button", { name: "İşlemi başlat" }).click();
  await expect
    .poll(async () => (await overview()).history.find((j) => j.kind === "verify")?.status, {
      timeout: 45_000,
    })
    .toBe("succeeded");
  await card.getByRole("button", { name: "Kurtarma dizinine çıkar", exact: true }).click();
  await action.getByLabel("Hesap parolanız").fill(PASSWORD);
  await action.getByRole("button", { name: "İşlemi başlat" }).click();
  await expect
    .poll(async () => (await overview()).history.find((j) => j.kind === "restore")?.status, {
      timeout: 60_000,
    })
    .toBe("succeeded");
  const restored = (await overview()).history.find((j) => j.kind === "restore")!;
  expect(restored.restorePath!.startsWith(join(devRoot, "linux-backup-target") + "/")).toBe(true);
  expect(await readFile(join(restored.restorePath!, "etc/backup-fixture"), "utf8")).toBe(
    "e2e-system-configuration\n",
  );
  expect(await readFile(join(restored.restorePath!, "home/backup-fixture"), "utf8")).toBe(
    "e2e-user-content\n",
  );
  await expect(lstat(join(restored.restorePath!, "home/excluded-fixture"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect((await lstat(join(restored.restorePath!, "etc/backup-fixture"))).mode & 0o777).toBe(0o640);
  expect(await readFile(join(devRoot, "linux-backup-source/etc/backup-fixture"), "utf8")).toBe(
    "changed-after-capture\n",
  );
  await expect(app.getByTestId("linux-recovery-path")).toBeVisible({ timeout: 15_000 });
  await expect(card.getByRole("heading", { name: "Encrypted Linux E2E" })).toBeVisible();
  await expect(card.getByText("Veri bütünlüğü doğrulanmış", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(card.getByText("Beklenmeyen bir sunucu hatası oluştu.")).toHaveCount(0);
  await card.getByRole("heading", { name: "Encrypted Linux E2E" }).scrollIntoViewIfNeeded();
  const titleBox = await card.getByRole("heading", { name: "Encrypted Linux E2E" }).boundingBox();
  const cardBox = await card.boundingBox();
  expect(titleBox!.y).toBeGreaterThanOrEqual(cardBox!.y);
  expect(cardBox!.height).toBeGreaterThan(200);
  await app.screenshot({ path: test.info().outputPath("linux-backup-recovered.png") });
});

test("missing BorgBackup can be installed from Backups with progress, sudo retry and readiness", async ({
  page,
}) => {
  await signIn(page);
  let installed = false;
  let installation: LinuxBackupInstallation | null = null;
  let attempts = 0;
  await page.route("**/api/linux-backups", (route) =>
    route.fulfill({
      json: {
        capability: {
          source: "simulated",
          available: installed,
          reason: installed ? "ready" : "borg-missing",
          version: installed ? "borg 1.4.5" : null,
          installationSupported: !installed,
          targets: [
            {
              id: "a".repeat(16),
              path: "/simulated/backup",
              device: "1",
              freeBytes: 1024 ** 4,
              available: true,
            },
          ],
          systemIncludes: ["/etc"],
          alwaysExcluded: ["/proc"],
        },
        plans: [],
        job: null,
        history: [],
        timezone: "Europe/Istanbul",
        installation,
      } satisfies LinuxBackupOverview,
    }),
  );
  await page.route("**/api/linux-backups/install", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ confirm: true, password: PASSWORD });
    attempts++;
    installation = {
      id:
        attempts === 1
          ? "03e8db27-15da-4ed2-9fe8-a275884e952f"
          : "53a6078c-4786-4815-b8f1-09d92735c512",
      status: "running",
      stage: "installing",
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    };
    await route.fulfill({ status: 202, json: installation });
  });
  const launch = async () => {
    await page
      .getByTestId("dock")
      .getByRole("button", { name: "Tüm uygulamalar", exact: true })
      .click();
    await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("Yedekler");
    await page.getByRole("option").filter({ hasText: "Yedekler" }).first().click();
    await page.getByRole("tab", { name: "Linux yedekleri", exact: true }).click();
  };
  await launch();
  const app = page.getByTestId("linux-backups-app");
  const panel = app.getByTestId("linux-backup-install");
  await expect(app.getByRole("button", { name: "Yedekleme planı oluştur" })).toBeDisabled();
  const start = async () => {
    await panel.getByRole("button", { name: "Kur", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "BorgBackup kurulumu" });
    await expect(dialog.getByRole("button", { name: "Kur", exact: true })).toBeDisabled();
    await dialog.getByLabel("Hesap parolanız").fill(PASSWORD);
    await dialog.getByRole("button", { name: "Kur", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(panel.getByText("BorgBackup kuruluyor…", { exact: true })).toBeVisible();
  };
  await start();
  await page
    .getByRole("region", { name: "Yedekler", exact: true })
    .getByRole("button", { name: "Kapat", exact: true })
    .click();
  await launch();
  await expect(panel.getByText("BorgBackup kuruluyor…", { exact: true })).toBeVisible();
  installation = {
    ...installation!,
    status: "failed",
    stage: "done",
    finishedAt: Date.now(),
    error: "LINUX_SUDO_REQUIRED",
  };
  await expect(
    panel.getByText(
      "Linux hesabınızı bağlayıp sudo yetkisini açın; ardından kurulumu yeniden başlatın.",
    ),
  ).toBeVisible();
  await expect(panel.getByRole("button").filter({ hasText: "Kur" })).toBeEnabled();
  await start();
  installed = true;
  installation = {
    ...installation,
    status: "succeeded",
    stage: "done",
    finishedAt: Date.now(),
    error: null,
  };
  await expect(panel.getByText("BorgBackup kuruldu ve kullanıma hazır.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Kur", exact: true })).toHaveCount(0);
  await expect(app.getByRole("button", { name: "Yedekleme planı oluştur" })).toBeEnabled();
  expect(attempts).toBe(2);
  await app.screenshot({ path: test.info().outputPath("borg-installed.png") });
});
