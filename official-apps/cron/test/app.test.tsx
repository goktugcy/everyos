import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronApp } from "../src/cron-app.tsx";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

async function start(locale = "en") {
  rendered = await renderApp(CronApp, {
    publicDir,
    app: { id: "dev.everyos.cron", version: "1.0.0", name: "Cron Builder" },
    granted: ["storage:app", "clipboard:write", "files:save"],
    locale,
    storage: {
      state: {
        expression: "0 9 * * 1-5",
        seconds: false,
        timeZone: "Europe/Istanbul",
        command: "",
      },
    },
  });
  await vi.waitFor(() => expect(document.querySelector(".cron-expression input")).not.toBeNull());
  return rendered;
}
const expression = () => document.querySelector<HTMLInputElement>(".cron-expression input")!;
const description = () => document.querySelector(".cron-description")?.textContent;

describe("Cron Builder", () => {
  it("describes the expression and lists next runs in the chosen time zone", async () => {
    await start("tr");
    await vi.waitFor(() => expect(description()).toMatch(/Pazartesi/));
    expect(document.querySelectorAll(".cron-runs li").length).toBeGreaterThanOrEqual(10);
    typeInto(expression(), "61 * * * *");
    await vi.waitFor(() => expect(description()).toBe("Dakika: 61 aralık dışında."));
  });

  it("builds the expression from the fields", async () => {
    await start();
    await vi.waitFor(() => expect(byRole("combobox", "How Minute is set")).not.toBeNull());
    const mode = byRole("combobox", "How Minute is set") as HTMLSelectElement;
    mode.value = "step";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(expression().value).toBe("*/15 9 * * 1-5"));
    // A click in the same task as the previous commit is lost in happy-dom (not in browsers).
    await new Promise((resolve) => setTimeout(resolve));
    byRole("button", "Weekly on Sunday")!.click();
    await vi.waitFor(() => expect(expression().value).toBe("0 0 * * 0"));
  });

  it("writes crontab, systemd and EveryOS forms and saves a timer file", async () => {
    const { host } = await start();
    typeInto(byRole("textbox", "Command"), "/usr/local/bin/backup.sh");
    await vi.waitFor(() =>
      expect(document.querySelector('pre[aria-label="crontab line"]')?.textContent).toBe(
        "0 9 * * 1-5 /usr/local/bin/backup.sh",
      ),
    );
    expect(
      document.querySelector('pre[aria-label="systemd timer (OnCalendar=)"]')?.textContent,
    ).toBe("Mon..Fri *-*-* 09:00:00 Europe/Istanbul");
    expect(byText("Compatible")).not.toBeNull();
    byRole("button", "Save a .timer file…")!.click();
    await vi.waitFor(() =>
      expect(host.readText("/job.timer")).toContain(
        "OnCalendar=Mon..Fri *-*-* 09:00:00 Europe/Istanbul",
      ),
    );
    expect(host.readText("/job.timer")).toContain("Description=/usr/local/bin/backup.sh");
  });
});
