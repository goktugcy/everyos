import { defineConfig } from "vitest/config";

// The app's tests run in a DOM against @everyos/app-testing's MOCK desktop.
export default defineConfig({
  test: {
    environment: "happy-dom",
    environmentOptions: { happyDOM: { url: "http://localhost/app/" } },
  },
});
