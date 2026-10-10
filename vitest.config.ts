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
          name: "web",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          environment: "node",
        },
      },
    ],
  },
});
