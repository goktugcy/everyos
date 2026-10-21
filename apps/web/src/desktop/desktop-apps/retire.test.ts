import { afterEach, describe, expect, it, vi } from "vitest";
import { RETIRE_GRACE_MS, retireLater } from "./retire.ts";

describe("retiring a closed app's bridge", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for the requests the app sent as it went away, or not at all when the page unloads", () => {
    vi.useFakeTimers();
    const listeners: Array<() => void> = [];
    const target = {
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
    };
    const first = vi.fn();
    retireLater(first, target as unknown as Window);
    vi.advanceTimersByTime(RETIRE_GRACE_MS - 1);
    expect(first).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).toHaveBeenCalledOnce();

    const second = vi.fn();
    const third = vi.fn();
    retireLater(second, target as unknown as Window);
    retireLater(third, target as unknown as Window);
    // The desktop page itself goes away: everything is finished right now, once.
    for (const listener of listeners) listener();
    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(RETIRE_GRACE_MS);
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
  });
});
