import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: [
            "packages/*/src/**/*.test.ts",
            "apps/api/src/**/*.test.ts",
            "apps/agent/src/**/*.test.ts",
          ],
          environment: "node",
        },
      },
      {
        test: {
          // Official desktop apps: their interfaces run in a DOM against the mock desktop.
          name: "official-apps",
          include: ["official-apps/*/test/**/*.test.{ts,tsx}"],
          environment: "happy-dom",
          environmentOptions: { happyDOM: { url: "http://localhost/app/" } },
          setupFiles: ["packages/app-testing/src/setup.ts"],
        },
      },
      {
        test: {
          name: "web",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          environment: "node",
        },
      },
    ],
  },
});
