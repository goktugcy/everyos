import { mountMockHost } from "@everyos/app-testing";
import { expect, it, vi } from "vitest";
import { serveLocales } from "./helpers.ts";

it("shows the note in a widget and opens the app", async () => {
  serveLocales();
  document.body.innerHTML = '<main id="app"></main>';
  const host = mountMockHost({
    kind: "widget",
    widgetId: "summary",
    granted: ["storage:app"],
    locale: "en",
    storage: { note: "Buy milk" },
  });
  await import("../src/widget.tsx");
  await vi.waitFor(() =>
    expect(document.querySelector(".summary span")?.textContent).toBe("Buy milk"),
  );
  document.querySelector<HTMLButtonElement>(".summary")!.click();
  await vi.waitFor(() => expect(host.calls.map((call) => call.method)).toContain("window.open"));
});
