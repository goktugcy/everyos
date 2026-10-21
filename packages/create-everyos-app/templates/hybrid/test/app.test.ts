import { mountMockHost } from "@everyos/app-testing";
import { expect, it, vi } from "vitest";
import { serveLocales } from "./helpers.ts";

it("shows the integration's monitors, through EveryOS", async () => {
  serveLocales();
  document.body.innerHTML = '<main id="app"></main>';
  mountMockHost({
    granted: ["integration:uptimekuma"],
    locale: "en",
    host: {
      "integration.list": () => ({
        integrations: [{ id: "k1", name: "Kuma", adapter: "uptimekuma", feeds: ["monitors"] }],
      }),
      "integration.data": () => ({
        status: "ok",
        at: 0,
        data: {
          up: 1,
          down: 1,
          pending: 0,
          maintenance: 0,
          monitors: [
            { name: "Website", type: "http", status: "up", responseMs: 120 },
            { name: "NAS", type: "ping", status: "down", responseMs: null },
          ],
        },
      }),
    },
  });
  await import("../src/main.tsx");
  await vi.waitFor(() => expect(document.querySelectorAll(".monitors li")).toHaveLength(2));
  expect(document.querySelector('[role="status"]')?.textContent).toBe("1 up · 1 down");
  expect(document.querySelector('[data-status="down"]')?.textContent).toContain("Down");
});
