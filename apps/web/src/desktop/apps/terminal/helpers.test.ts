import { describe, expect, it, vi, afterEach } from "vitest";
import {
  closeReason,
  debounceResize,
  inputFrames,
  reconnectDelay,
  serverMessage,
  sessionKey,
  terminalSize,
  terminalUrl,
} from "./helpers.ts";

const id = "8b2fd8b1-62ef-4ad4-a1cd-8d430e0d055f";
afterEach(() => vi.useRealTimers());

describe("terminal protocol helpers", () => {
  it.each([4000, 4403, 4404, 4409, 4429])("never reconnects after final close %s", (code) => {
    expect(closeReason(code)).not.toBeNull();
  });
  it.each([1000, 1001, 1006, 1011, 1012, 1013])(
    "reconnects after an unexpected close %s",
    (code) => {
      expect(closeReason(code)).toBeNull();
    },
  );
  it("backs off exponentially with a bounded delay", () => {
    expect([0, 1, 2, 3, 4, 10].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
  });
  it("debounces to the most recent bounded size and cancels pending sends", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const resize = debounceResize(send);
    resize.push(80, 24);
    vi.advanceTimersByTime(60);
    resize.push(600, 301);
    vi.advanceTimersByTime(99);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "resize", cols: 500, rows: 300 });
    resize.push(0, 1);
    resize.cancel();
    vi.runAllTimers();
    expect(send).toHaveBeenCalledTimes(1);
    expect(terminalSize(0, 1)).toEqual({ type: "resize", cols: 2, rows: 2 });
    expect(terminalSize(NaN, Infinity)).toEqual({ type: "resize", cols: 80, rows: 24 });
  });
  it("uses same-origin ws/wss and resumes only the requested session", () => {
    const url = new URL(terminalUrl("https://everyos.example", 100, 32, id));
    expect(url.origin).toBe("wss://everyos.example");
    expect(url.pathname).toBe("/api/terminal/ws");
    expect(url.searchParams.get("session")).toBe(id);
    expect(url.searchParams.get("cols")).toBe("100");
    expect(terminalUrl("http://localhost:7470", 80, 24, null)).toBe(
      "ws://localhost:7470/api/terminal/ws?cols=80&rows=24",
    );
    expect(sessionKey("alice", "one")).not.toBe(sessionKey("bob", "one"));
    expect(sessionKey("alice", "one")).not.toBe(sessionKey("alice", "two"));
  });
  it("accepts all exit reasons and validates ready frames without zod", () => {
    const ready = {
      type: "ready",
      sessionId: id,
      account: "operator",
      shell: "/bin/bash",
      resumed: true,
    };
    expect(serverMessage(JSON.stringify(ready))).toEqual(ready);
    for (const reason of ["exited", "idle", "closed", "revoked", "error"])
      expect(serverMessage(JSON.stringify({ type: "exit", reason, code: null }))).toEqual({
        type: "exit",
        reason,
        code: null,
      });
    for (const bad of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...ready, sessionId: "invalid" }),
      JSON.stringify({ type: "exit", reason: "invented", code: 0 }),
    ])
      expect(serverMessage(bad)).toBeNull();
  });
  it("splits large Unicode pastes into binary frames without losing bytes", () => {
    const text = "ğ🌲".repeat(30_000);
    const frames = inputFrames(text);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.length <= 64 * 1024)).toBe(true);
    const bytes = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
    let offset = 0;
    for (const frame of frames) {
      bytes.set(frame, offset);
      offset += frame.length;
    }
    expect(new TextDecoder().decode(bytes)).toBe(text);
    expect(inputFrames("")).toEqual([]);
  });
});
