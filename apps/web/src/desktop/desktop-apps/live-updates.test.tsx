// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TopicHandlers } from "../../lib/event-stream.ts";

const state = vi.hoisted(() => ({
  handlers: null as TopicHandlers | null,
  stop: vi.fn(),
  load: vi.fn((_locale: string, _signal?: AbortSignal): Promise<void> => Promise.resolve()),
}));
vi.mock("../../app/i18n.ts", () => ({ i18next: { language: "en" } }));
vi.mock("./store.ts", () => ({ loadDesktopApps: state.load }));
vi.mock("../../lib/event-stream.ts", () => ({
  subscribeTopic: (_topic: string, handlers: TopicHandlers) => {
    state.handlers = handlers;
    return state.stop;
  },
}));
import { useDesktopAppRefresh } from "./live-updates.ts";

function Probe({
  enabled = true,
  notifications = true,
}: {
  enabled?: boolean;
  notifications?: boolean;
}) {
  useDesktopAppRefresh(enabled, "test-session", notifications);
  return null;
}
async function flush(run: () => void | Promise<unknown>) {
  await act(async () => {
    await run();
  });
}

let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.load.mockImplementation(() => Promise.resolve());
  state.handlers = null;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await flush(() => root.unmount());
  element.remove();
  vi.useRealTimers();
});

describe("desktop app update recovery", () => {
  it("polls without requesting a forbidden notification topic for an apps-only user", async () => {
    await flush(() => root.render(<Probe notifications={false} />));
    expect(state.handlers).toBeNull();
    await flush(() => vi.advanceTimersByTimeAsync(60_000));
    expect(state.load).toHaveBeenCalledTimes(2);
  });
  it("refreshes runtime URLs on automatic-update events and on reconnect, without a page reload", async () => {
    await flush(() => root.render(<Probe />));
    expect(state.load).toHaveBeenCalledTimes(1);
    await flush(() => {
      state.handlers?.events?.notifications?.({ latest: { kind: "desktop-app-updated" } });
    });
    expect(state.load).toHaveBeenCalledTimes(2);
    await flush(() => {
      state.handlers?.ready?.();
    });
    expect(state.load).toHaveBeenCalledTimes(3);
  });
  it("replays an event that arrives while an older listing is still loading", async () => {
    let finish!: () => void;
    state.load.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          finish = done;
        }),
    );
    await flush(() => root.render(<Probe />));
    await flush(() => {
      state.handlers?.events?.notifications?.({ latest: { kind: "desktop-app-updated" } });
    });
    expect(state.load).toHaveBeenCalledTimes(1);
    await flush(() => finish());
    expect(state.load).toHaveBeenCalledTimes(2);
  });
  it("recovers missed events by polling and visibility, stopping reads when locked", async () => {
    await flush(() => root.render(<Probe />));
    await flush(() => vi.advanceTimersByTimeAsync(60_000));
    expect(state.load).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await flush(() => vi.advanceTimersByTimeAsync(60_000));
    expect(state.load).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await flush(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(state.load).toHaveBeenCalledTimes(3);
    const signal = state.load.mock.calls[0]![1]!;
    await flush(() => root.render(<Probe enabled={false} />));
    expect(signal.aborted).toBe(true);
    expect(state.stop).toHaveBeenCalledTimes(1);
    await flush(() => vi.advanceTimersByTimeAsync(60_000));
    expect(state.load).toHaveBeenCalledTimes(3);
  });
});
