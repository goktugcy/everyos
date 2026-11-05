import { expect, test } from "@playwright/test";
import type {
  LinuxBackupOverview,
  LinuxBackupJob,
  LinuxBackupPlan,
} from "../../packages/shared/src/index.ts";
import { PASSWORD, signIn } from "./helpers.ts";

test("Linux backup plans can be disabled, enabled and removed; refresh remains continuous through backup and cancellation", async ({
  page,
}) => {
  await signIn(page);
  const plan: LinuxBackupPlan = {
    id: "0820e237-0d3b-49e7-96cc-c94c667459b6",
    name: "Archive controls fixture",
    enabled: true,
    scope: "system",
    includes: [],
    excludes: [],
    excludeCaches: true,
    targetId: "a".repeat(16),
    targetPath: "/simulated/backup",
    targetDevice: "1",
    encryption: "repokey-blake2",
    compression: "lz4",
    retention: { enabled: false, hourly: 24, daily: 7, weekly: 4, monthly: 12 },
    schedule: { frequency: "manual", hour: 3, minute: 0, weekday: 0, day: 1 },
    taskId: null,
    createdAt: Date.now(),
    nextRunAt: null,
    scheduleOverride: null,
  };
  const archive = {
    id: "b".repeat(64),
    name: "eos-20261105T120000Z-12345678",
    createdAt: Date.now() - 3600000,
    verification: "verified",
    scope: "system",
  };
  let visible = true;
  let planVisible = true;
  let overviewRequests = 0;
  let planDeletes = 0;
  const planStates: boolean[] = [];
  let job: LinuxBackupJob | null = null;
  const history: LinuxBackupJob[] = [];
  let holdOverview = false;
  let holdArchives = false;
  let releaseOverview!: () => void;
  let releaseArchives!: () => void;
  const overviewGate = new Promise<void>((resolve) => {
    releaseOverview = resolve;
  });
  const archiveGate = new Promise<void>((resolve) => {
    releaseArchives = resolve;
  });
  let overviewHeld = false;
  let archivesHeld = false;
  let overviewFinished = false;
  let deleteRequests = 0;
  let cancelRequests = 0;
  const makeJob = (kind: LinuxBackupJob["kind"], id: string): LinuxBackupJob => ({
    id,
    planId: plan.id,
    kind,
    status: "running",
    stage: kind === "delete" ? "deleting" : "archiving",
    archive: kind === "delete" ? archive.name : null,
    startedAt: Date.now(),
    finishedAt: null,
    files: 2,
    bytes: 1024,
    compressedBytes: 512,
    deduplicatedBytes: 256,
    error: null,
    restorePath: null,
  });
  await page.route("**/api/linux-backups", async (route) => {
    overviewRequests++;
    if (holdOverview) {
      overviewHeld = true;
      await overviewGate;
    }
    await route.fulfill({
      json: {
        capability: {
          source: "simulated",
          available: true,
          reason: "ready",
          version: "borg 1.4.5",
          installationSupported: false,
          targets: [
            {
              id: plan.targetId,
              path: plan.targetPath,
              device: plan.targetDevice,
              freeBytes: 1024 ** 4,
              available: true,
            },
          ],
          systemIncludes: ["/etc"],
          alwaysExcluded: ["/proc"],
        },
        plans: planVisible ? [plan] : [],
        job,
        history,
        timezone: "Europe/Istanbul",
        installation: null,
      } satisfies LinuxBackupOverview,
    });
    if (holdOverview) overviewFinished = true;
  });
  await page.route(`**/api/linux-backups/plans/${plan.id}/archives`, async (route) => {
    if (holdArchives) {
      archivesHeld = true;
      await archiveGate;
    }
    await route.fulfill({ json: { archives: visible ? [archive] : [], limit: 1000 } });
  });
  await page.route(`**/api/linux-backups/plans/${plan.id}/jobs`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      kind: "delete",
      archive: archive.name,
      password: PASSWORD,
      confirm: true,
    });
    deleteRequests++;
    job = makeJob("delete", "fd74a7da-530b-415a-8f66-c17e38b9e1c1");
    await route.fulfill({ status: 202, json: job });
  });
  await page.route("**/api/linux-backups/cancel", async (route) => {
    cancelRequests++;
    await route.fulfill({ json: { cancelled: true } });
  });
  await page.route(`**/api/linux-backups/plans/${plan.id}/state`, async (route) => {
    const body = route.request().postDataJSON() as { password: string; enabled: boolean };
    expect(body.password).toBe(PASSWORD);
    expect(typeof body.enabled).toBe("boolean");
    plan.enabled = body.enabled;
    planStates.push(body.enabled);
    await route.fulfill({ json: plan });
  });
  await page.route(`**/api/linux-backups/plans/${plan.id}`, async (route) => {
    expect(route.request().method()).toBe("DELETE");
    expect(route.request().postDataJSON()).toEqual({ password: PASSWORD, confirm: true });
    planDeletes++;
    planVisible = false;
    await route.fulfill({ json: { deleted: true, archivesPreserved: true } });
  });
  try {
    await page
      .getByTestId("dock")
      .getByRole("button", { name: "Tüm uygulamalar", exact: true })
      .click();
    await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("Yedekler");
    await page.getByRole("option").filter({ hasText: "Yedekler" }).first().click();
    await page.getByRole("tab", { name: "Linux yedekleri", exact: true }).click();
    const app = page.getByTestId("linux-backups-app");
    const card = app.getByTestId("linux-backup-plan");
    await card.getByRole("button", { name: "Yedekler", exact: true }).click();
    await expect(card.getByRole("button", { name: "Yedeği sil", exact: true })).toBeVisible();
    const refresh = app.getByRole("button", { name: "Yenile", exact: true });
    await expect(refresh).toBeEnabled();
    holdOverview = true;
    holdArchives = true;
    await refresh.click();
    await expect.poll(() => overviewHeld && archivesHeld).toBe(true);
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(refresh.locator("svg")).toHaveClass(/animate-spin/);
    releaseOverview();
    await expect.poll(() => overviewFinished).toBe(true);
    await expect(refresh).toBeDisabled();
    releaseArchives();
    holdOverview = false;
    holdArchives = false;
    await expect(refresh).toBeEnabled();
    await expect(refresh.locator("svg")).not.toHaveClass(/animate-spin/);
    await card.getByRole("button", { name: "Yedeği sil", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Yedeği sil", exact: true });
    await expect(dialog.getByText(archive.name, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Yedeği kalıcı olarak sil" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Vazgeç", exact: true }).click();
    expect(deleteRequests).toBe(0);
    await card.getByRole("button", { name: "Yedeği sil", exact: true }).click();
    await dialog.getByLabel("Hesap parolanız").fill(PASSWORD);
    await dialog.getByRole("button", { name: "Yedeği kalıcı olarak sil" }).click();
    await expect(
      app.getByTestId("linux-backup-job").getByText("Yedek siliniyor", { exact: true }),
    ).toBeVisible();
    history.unshift({ ...job!, status: "succeeded", stage: "done", finishedAt: Date.now() });
    job = null;
    visible = false;
    await expect(card.getByText("Henüz tamamlanmış yedek yok.")).toBeVisible();
    await expect(card.getByRole("button", { name: "Yedeği sil", exact: true })).toHaveCount(0);
    expect(deleteRequests).toBe(1);
    job = makeJob("create", "7e165660-f03c-41ab-8dc7-f030ffafc067");
    await expect(refresh).toBeEnabled();
    await refresh.click();
    const running = app.getByTestId("linux-backup-job");
    await expect(running).toBeVisible();
    await expect(card.getByRole("button", { name: "Planı sil", exact: true })).toBeDisabled();
    const refreshIcon = refresh.locator("svg");
    await expect(refreshIcon).toHaveClass(/animate-spin/);
    await expect
      .poll(() => refreshIcon.evaluate((element) => element.getAnimations()[0]?.startTime ?? 0))
      .toBeGreaterThan(0);
    const animationStarted = await refreshIcon.evaluate(
      (element) => element.getAnimations()[0]?.startTime,
    );
    expect(animationStarted).toBeGreaterThan(0);
    const polled = overviewRequests;
    await expect.poll(() => overviewRequests, { timeout: 10_000 }).toBeGreaterThan(polled + 2);
    expect(await refreshIcon.evaluate((element) => element.getAnimations()[0]?.startTime)).toBe(
      animationStarted,
    );
    const cancelled = page.waitForResponse((response) =>
      response.url().endsWith("/api/linux-backups/cancel"),
    );
    await running.getByRole("button", { name: "İşlemi durdur", exact: true }).click();
    await cancelled;
    const stopping = running.getByRole("button", { name: "İşlem durduruluyor…", exact: true });
    await expect(stopping).toHaveAttribute("aria-busy", "true");
    await expect(stopping).toBeDisabled();
    await expect(stopping.locator("svg.animate-spin")).toBeVisible();
    expect(await refreshIcon.evaluate((element) => element.getAnimations()[0]?.startTime)).toBe(
      animationStarted,
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(refreshIcon).toHaveCSS("animation-name", "none");
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    history.unshift({ ...job, status: "cancelled", stage: "done", finishedAt: Date.now() });
    job = null;
    await expect(running).toHaveCount(0);
    await expect(refreshIcon).not.toHaveClass(/animate-spin/);
    expect(cancelRequests).toBe(1);
    await card.getByRole("button", { name: "Devre dışı bırak", exact: true }).click();
    const disable = page.getByRole("dialog", { name: "Devre dışı bırak", exact: true });
    await expect(
      disable.getByRole("button", { name: "Devre dışı bırak", exact: true }),
    ).toBeDisabled();
    await disable.getByLabel("Hesap parolanız").fill(PASSWORD);
    await disable.getByRole("button", { name: "Devre dışı bırak", exact: true }).click();
    await expect(card.getByRole("button", { name: "Etkinleştir", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Şimdi yedekle", exact: true })).toBeDisabled();
    await app.screenshot({ path: test.info().outputPath("linux-plan-disabled.png") });
    await card.getByRole("button", { name: "Etkinleştir", exact: true }).click();
    const enable = page.getByRole("dialog", { name: "Etkinleştir", exact: true });
    await enable.getByLabel("Hesap parolanız").fill(PASSWORD);
    await enable.getByRole("button", { name: "Etkinleştir", exact: true }).click();
    await expect(card.getByRole("button", { name: "Şimdi yedekle", exact: true })).toBeEnabled();
    expect(planStates).toEqual([false, true]);
    await card.getByRole("button", { name: "Planı sil", exact: true }).click();
    const remove = page.getByRole("dialog", { name: "Planı sil", exact: true });
    await expect(
      remove.getByText(`${plan.targetPath}/everyos-linux-${plan.id}/repository`, { exact: true }),
    ).toBeVisible();
    await expect(
      remove.getByText(/Kayıtlı yedek şifreleme parolası da kaldırılacak/),
    ).toBeVisible();
    await remove.screenshot({ path: test.info().outputPath("linux-plan-delete-confirm.png") });
    await remove.getByRole("button", { name: "Vazgeç", exact: true }).click();
    expect(planDeletes).toBe(0);
    await card.getByRole("button", { name: "Planı sil", exact: true }).click();
    await remove.getByLabel("Hesap parolanız").fill(PASSWORD);
    await remove.getByRole("button", { name: "Planı sil", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(
      app.getByRole("status").filter({ hasText: "Plan silindi. Diskteki yedekler korundu." }),
    ).toBeVisible();
    expect(planDeletes).toBe(1);
  } finally {
    releaseOverview();
    releaseArchives();
  }
});
