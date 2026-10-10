import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.OTUKEN_E2E_PORT ?? 7480);

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: "../../test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    locale: "tr-TR",
  },
  projects: [{ name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node tests/e2e/start-stack.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
