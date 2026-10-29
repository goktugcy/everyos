import { expect, test } from "@playwright/test";
import type { SelfUpdateStatus } from "../../packages/shared/src/index.ts";
import { signIn } from "./helpers.ts";

test("a completed update reloads the page once with Updates closed, including missed events", async ({
  page,
}) => {
  await signIn(page);
  const original = await page.evaluate(
    async () => (await (await fetch("/api/self-update")).json()) as SelfUpdateStatus,
  );
  // Status is a fixture: this test performs a real page reload, never a host installation.
  let snapshot: SelfUpdateStatus = {
    ...original,
    configured: true,
    reason: null,
    job: {
      id: "e262f116-7104-448c-a051-a07b623881ca",
      version: "99.0.0",
      previousVersion: original.installedVersion,
      backupId: "fixture-backup",
      state: "installing",
      createdAt: Date.now(),
      finishedAt: null,
      error: null,
    },
  };
  let reads = 0;
  await page.route("**/api/self-update", async (route) => {
    reads++;
    await route.fulfill({ json: snapshot });
  });
  // Simulate a disconnected event stream so the background recovery read has to detect completion.
  await page.route("**/api/events?**", (route) => route.abort());
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  const refresh = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await refresh();
  await expect.poll(() => reads).toBeGreaterThan(0);
  expect(navigations).toBe(0);
  snapshot = {
    ...snapshot,
    installedVersion: "99.0.0",
    job: { ...snapshot.job!, state: "succeeded", finishedAt: Date.now() },
  };
  await refresh();
  await expect.poll(() => navigations).toBe(1);
  await expect(page.getByTestId("desktop")).toBeVisible();
  const previousReads = reads;
  await refresh();
  await expect.poll(() => reads).toBeGreaterThan(previousReads);
  // The retained completed job must not cause another reload of this same tab.
  await page.waitForTimeout(300);
  expect(navigations).toBe(1);
});
