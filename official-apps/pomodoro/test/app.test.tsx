import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import type { MockHostOptions } from "@everyos/app-testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PomodoroApp } from "../src/pomodoro-app.tsx";
import { TimerWidget } from "../src/timer-widget.tsx";
import { DEFAULT_SETTINGS, initialState, type TimerState } from "../src/timer.ts";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.useRealTimers();
});

async function start(options: MockHostOptions = {}, Root = PomodoroApp) {
  rendered = await renderApp(Root, {
    publicDir,
    app: { id: "dev.everyos.pomodoro", version: "1.0.0", name: "Pomodoro" },
    granted: ["storage:app", "notifications:send", "widgets:register"],
    ...options,
  });
  return rendered;
}

const clock = () => document.querySelector("[role=timer]")?.textContent;
async function openTab(name: string) {
  await vi.waitFor(() => expect(byRole("tab", name)).not.toBeNull());
  byRole("tab", name)!.click();
}

describe("Pomodoro", () => {
  it("starts, pauses and keeps the state where the widget sees it", async () => {
    const { host } = await start({ locale: "tr" });
    await vi.waitFor(() => expect(clock()).toBe("25:00"));
    byRole("button", "Başlat")!.click();
    await vi.waitFor(() =>
      expect(host.storage.get("state")).toMatchObject({ status: "running", phase: "focus" }),
    );
    await vi.waitFor(() => expect(host.window.title).toMatch(/^2[45]:\d\d · Odak$/));
    byRole("button", "Duraklat")!.click();
    await vi.waitFor(() => expect(host.storage.get("state")).toMatchObject({ status: "paused" }));
    expect(byRole("button", "Devam et")).not.toBeNull();
  });

  it("finishes a phase that ended while it was closed, records it and notifies once", async () => {
    const now = Date.now();
    const state: TimerState = {
      ...initialState(DEFAULT_SETTINGS),
      status: "running",
      startedAt: now - 25 * 60_000 - 5000,
      endsAt: now - 5000,
      label: "Report",
      rev: 7,
    };
    const { host } = await start({ storage: { state } });
    await vi.waitFor(() =>
      expect(host.storage.get("state")).toMatchObject({ phase: "short", status: "idle", cycle: 1 }),
    );
    await vi.waitFor(() =>
      expect(host.storage.get("history")).toEqual([
        expect.objectContaining({ label: "Report", minutes: 25, completed: true }),
      ]),
    );
    await vi.waitFor(() =>
      expect(host.notifications).toEqual([
        expect.objectContaining({
          title: "Focus session complete",
          body: "Take a 5-minute break.",
        }),
      ]),
    );
    expect(clock()).toBe("05:00");
  });

  it("does not notify without the permission, and explains it in the settings", async () => {
    const now = Date.now();
    const { host } = await start({
      granted: ["storage:app"],
      storage: {
        state: {
          ...initialState(DEFAULT_SETTINGS),
          status: "running",
          startedAt: now - 26 * 60_000,
          endsAt: now - 60_000,
          rev: 1,
        },
      },
    });
    await vi.waitFor(() => expect(host.storage.get("state")).toMatchObject({ phase: "short" }));
    expect(host.notifications).toEqual([]);
    await openTab("Settings");
    await vi.waitFor(() => expect(byText(/was not allowed to send notifications/)).not.toBeNull());
  });

  it("changes durations, which an idle timer takes at once", async () => {
    const { host } = await start();
    await openTab("Settings");
    await vi.waitFor(() => expect(byRole("spinbutton", "Focus (minutes)")).not.toBeNull());
    const focus = document.querySelector<HTMLInputElement>('input[aria-label="Focus (minutes)"]')!;
    typeInto(focus, "50");
    await vi.waitFor(() =>
      expect(host.storage.get("settings")).toMatchObject({ focusMinutes: 50 }),
    );
    await openTab("Timer");
    await vi.waitFor(() => expect(clock()).toBe("50:00"));
  });

  it("shows history and statistics", async () => {
    const end = Date.now();
    await start({
      storage: {
        history: [
          {
            id: "focus:1",
            start: end - 25 * 60_000,
            end,
            minutes: 25,
            label: "Writing",
            completed: true,
          },
        ],
      },
    });
    await openTab("History");
    await vi.waitFor(() => expect(byText("Writing")).not.toBeNull());
    expect(byText("1 session")).not.toBeNull();
    await openTab("Statistics");
    await vi.waitFor(() => expect(byText("Focused today")).not.toBeNull());
    expect(document.querySelector(".pomo-card-value")?.textContent).toBe("25 min");
  });
});

describe("the timer widget", () => {
  it("starts the shared timer and opens the app", async () => {
    const { host } = await start(
      { kind: "widget", widgetId: "timer", granted: ["storage:app"] },
      TimerWidget,
    );
    await vi.waitFor(() => expect(clock()).toBe("25:00"));
    byRole("button", "Start")!.click();
    await vi.waitFor(() => expect(host.storage.get("state")).toMatchObject({ status: "running" }));
    byRole("button", "Open Pomodoro")!.click();
    await vi.waitFor(() =>
      expect(host.calls.some((call) => call.method === "window.open")).toBe(true),
    );
  });
});
