import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiRequestError } from "../../lib/api.ts";
import type * as ApiModule from "../../lib/api.ts";
import { DEFAULT_SECURITY } from "./defaults.ts";
import {
  discardPending,
  flushPending,
  loadPreferences,
  resetPreference,
  scheduleSave,
  usePreferences,
} from "./preferences-store.ts";
import type { LoadContext } from "./preferences-store.ts";

vi.mock("../../lib/api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock("../theme/theme-store.ts", () => ({ applyAppearance: vi.fn() }));

const client = vi.mocked(api);
const context: LoadContext = {
  t: ((key: string) => key) as LoadContext["t"],
  permissions: ["system:read", "preferences:manage"],
};

beforeEach(() => {
  vi.useFakeTimers();
  client.mockReset();
  discardPending();
  usePreferences.setState({ ready: false, saveError: false, security: DEFAULT_SECURITY });
});
afterEach(() => {
  discardPending();
  vi.useRealTimers();
});

describe("preference persistence", () => {
  it("waits for an existing write before sending a newer value or signing out", async () => {
    const slow = Promise.withResolvers<void>();
    client.mockReturnValueOnce(slow.promise).mockResolvedValue(undefined);
    scheduleSave("security", () => ({ version: 1, autoLockMinutes: 5 }));
    const first = flushPending();
    scheduleSave("security", () => ({ version: 1, autoLockMinutes: 10 }));
    const final = flushPending();
    expect(client).toHaveBeenCalledTimes(1);
    slow.resolve();
    await Promise.all([first, final]);
    expect(client).toHaveBeenCalledTimes(2);
    expect(client.mock.calls[1]?.[1]?.body).toEqual({ version: 1, autoLockMinutes: 10 });
  });

  it("does not retry a failed request from a previous user's session", async () => {
    const slow = Promise.withResolvers<void>();
    client.mockReturnValueOnce(slow.promise);
    scheduleSave("security", () => ({ version: 1, autoLockMinutes: 5 }));
    const saving = flushPending();
    discardPending();
    slow.reject(new ApiRequestError(0, "NETWORK", "Offline"));
    await saving;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client).toHaveBeenCalledTimes(1);
    expect(usePreferences.getState().saveError).toBe(false);
  });

  it("orders resetting to defaults after an in-flight edit", async () => {
    const slow = Promise.withResolvers<void>();
    client.mockReturnValueOnce(slow.promise).mockResolvedValue(undefined);
    scheduleSave("security", () => ({ version: 1, autoLockMinutes: 5 }));
    const first = flushPending();
    resetPreference("security", DEFAULT_SECURITY);
    const final = flushPending();
    slow.resolve();
    await Promise.all([first, final]);
    expect(client.mock.calls[1]?.[1]).toMatchObject({ method: "PUT", body: DEFAULT_SECURITY });
  });

  it("keeps existing preferences when loading fails instead of replacing them with defaults", async () => {
    usePreferences.setState({ security: { version: 1, autoLockMinutes: 15 } });
    client.mockRejectedValueOnce(new ApiRequestError(0, "NETWORK", "Offline"));
    await expect(loadPreferences(context)).rejects.toMatchObject({ code: "NETWORK" });
    expect(usePreferences.getState()).toMatchObject({
      ready: false,
      security: { autoLockMinutes: 15 },
    });
  });

  it("discards a response after loading is cancelled or the session changes", async () => {
    const slow = Promise.withResolvers<{ preferences: object }>();
    client.mockReturnValueOnce(slow.promise);
    const controller = new AbortController();
    const loading = loadPreferences(context, controller.signal);
    controller.abort();
    discardPending();
    slow.resolve({ preferences: {} });
    await loading;
    expect(usePreferences.getState().ready).toBe(false);
  });
});
