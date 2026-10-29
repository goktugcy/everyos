import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const initial = () => ({
    phase: "authenticated",
    locked: false,
    session: { session: { id: "session-a" }, permissions: ["system:read"] },
  });
  type State = ReturnType<typeof initial>;
  return {
    initial,
    state: initial(),
    listeners: new Set<(state: State, previous: State) => void>(),
  };
});

vi.mock("../stores/session-store.ts", () => ({
  useSessionStore: {
    getState: () => fixture.state,
    subscribe: (
      listener: (state: typeof fixture.state, previous: typeof fixture.state) => void,
    ) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
  },
}));
vi.mock("./api.ts", () => ({ api: vi.fn(() => Promise.resolve(undefined)) }));

class TestEventSource extends EventTarget {
  static CLOSED = 2;
  static instances: TestEventSource[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    TestEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = TestEventSource.CLOSED;
  }

  release(value: unknown): void {
    this.dispatchEvent(Object.assign(new Event("release.status"), { data: JSON.stringify(value) }));
  }
}

function setState(next: typeof fixture.state): void {
  const previous = fixture.state;
  fixture.state = next;
  for (const listener of fixture.listeners) listener(next, previous);
}

describe("shared release snapshots", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    fixture.state = fixture.initial();
    fixture.listeners.clear();
    TestEventSource.instances = [];
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    vi.stubGlobal("EventSource", TestEventSource);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("delivers the latest snapshot to a window joining an existing release stream", async () => {
    const { subscribeTopic } = await import("./event-stream.ts");
    const observer = vi.fn();
    subscribeTopic("release", { events: { "release.status": observer } });
    vi.advanceTimersByTime(30);
    const stream = TestEventSource.instances[0]!;
    stream.release({ installedVersion: "1.0.0" });
    stream.release({ installedVersion: "1.0.1" });

    const window = vi.fn();
    subscribeTopic("release", { events: { "release.status": window } });
    vi.advanceTimersByTime(30);
    expect(window).toHaveBeenCalledExactlyOnceWith({ installedVersion: "1.0.1" });
    expect(observer).toHaveBeenCalledTimes(2);
    expect(TestEventSource.instances).toHaveLength(1);
  });

  it.each(["lock", "logout", "session", "permission"])(
    "discards a snapshot after a %s change and rejects the previous stream",
    async (change) => {
      const { subscribeTopic } = await import("./event-stream.ts");
      subscribeTopic("release", {});
      vi.advanceTimersByTime(30);
      const oldStream = TestEventSource.instances[0]!;
      oldStream.release({ installedVersion: "1.0.0" });
      const next = fixture.initial();
      if (change === "lock") next.locked = true;
      if (change === "logout") next.phase = "login";
      if (change === "session") next.session.session.id = "session-b";
      if (change === "permission") next.session.permissions = [];
      setState(next);
      oldStream.release({ installedVersion: "stale" });
      if (change === "lock" || change === "logout") setState(fixture.initial());

      const window = vi.fn();
      subscribeTopic("release", { events: { "release.status": window } });
      expect(window).not.toHaveBeenCalled();
    },
  );

  it("discards the snapshot when its last subscriber leaves", async () => {
    const { subscribeTopic } = await import("./event-stream.ts");
    const unsubscribe = subscribeTopic("release", {});
    vi.advanceTimersByTime(30);
    TestEventSource.instances[0]!.release({ installedVersion: "1.0.0" });
    unsubscribe();
    TestEventSource.instances[0]!.release({ installedVersion: "stale" });
    const window = vi.fn();
    subscribeTopic("release", { events: { "release.status": window } });
    expect(window).not.toHaveBeenCalled();
  });
});
