import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.EVERYOS_E2E_PORT ?? 7480);
const httpHost = process.env.EVERYOS_E2E_HTTP_HOST;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: "../../test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://${httpHost ?? "127.0.0.1"}:${port}`,
    launchOptions: {
      args: httpHost
        ? [`--host-resolver-rules=MAP ${httpHost} 127.0.0.1`, "--no-proxy-server"]
        : [],
    },
    trace: "retain-on-failure",
    // English, the product default: a fresh browser opens EveryOS in its own language when it has it.
    locale: "en-US",
  },
  projects: [{ name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node tests/e2e/start-stack.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    // The fixture registry builds and packs every official app first.
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
