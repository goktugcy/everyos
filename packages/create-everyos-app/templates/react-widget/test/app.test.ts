import { mountMockHost } from "@everyos/app-testing";
import { expect, it, vi } from "vitest";
import { serveLocales } from "./helpers.ts";

it("keeps the note, in the person's language, and copies it", async () => {
  serveLocales();
  document.body.innerHTML = '<main id="app"></main>';
  const host = mountMockHost({
    app: { id: "%%APP_ID%%", version: "1.0.0", name: "%%APP_NAME%%" },
    granted: ["storage:app", "clipboard:write"],
    locale: "tr",
    storage: { note: "Merhaba" },
  });
  await import("../src/main.tsx");
  await vi.waitFor(() => expect(document.querySelector("textarea")?.value).toBe("Merhaba"));
  expect(document.querySelector("h1")?.textContent).toBe("Notlar");
  document.querySelector("button")!.click();
  await vi.waitFor(() => expect(host.clipboard).toEqual(["Merhaba"]));
  expect(host.ready).toBe(true);
});
