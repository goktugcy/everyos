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
  await import("../src/main.ts");
  await vi.waitFor(() => expect(host.ready).toBe(true));
  expect(document.querySelector("h1")?.textContent).toBe("Notlar");
  const note = document.querySelector("textarea")!;
  expect(note.value).toBe("Merhaba");

  note.value = "Merhaba dünya";
  note.dispatchEvent(new Event("input"));
  await vi.waitFor(() => expect(host.storage.get("note")).toBe("Merhaba dünya"));
  document.querySelector("button")!.click();
  await vi.waitFor(() => expect(host.clipboard).toEqual(["Merhaba dünya"]));
});
