import type { NotificationView } from "@everyos/shared";
import { describe, expect, it, vi } from "vitest";
import { notificationAction } from "./content.ts";
import { shouldToast, unreadTotal } from "./store.ts";

vi.mock("../../lib/event-stream.ts", () => ({ subscribeTopic: vi.fn() }));
vi.mock("../../stores/session-store.ts", () => ({ useSessionStore: vi.fn() }));
vi.mock("../state/preferences-store.ts", () => ({ usePreferences: { getState: vi.fn() } }));

const base: NotificationView = {
  id: "n1",
  kind: "service-failed",
  category: "services",
  severity: "critical",
  params: { unit: "a.service" },
  count: 1,
  createdAt: 1,
  updatedAt: 1,
  resolvedAt: null,
  read: false,
};
const preferences = {
  version: 1 as const,
  toasts: true,
  toastMinSeverity: "warning" as const,
  mutedCategories: [] as NotificationView["category"][],
};

describe("notification preferences", () => {
  it("counts unread notifications outside muted categories", () => {
    expect(unreadTotal({ services: 2, security: 1 }, [])).toBe(3);
    expect(unreadTotal({ services: 2, security: 1 }, ["security"])).toBe(2);
  });

  it("pops up only what the user asked for", () => {
    expect(shouldToast(base, preferences)).toBe(true);
    expect(shouldToast({ ...base, severity: "success" }, preferences)).toBe(false);
    expect(shouldToast(base, { ...preferences, mutedCategories: ["services"] })).toBe(false);
    expect(shouldToast(base, { ...preferences, toasts: false })).toBe(false);
    expect(shouldToast({ ...base, read: true }, preferences)).toBe(false);
    expect(
      shouldToast({ ...base, severity: "info" }, { ...preferences, toastMinSeverity: "info" }),
    ).toBe(true);
  });

  it("always pops up plugged-in and removed disks, unless pop-ups or the category are off", () => {
    const disk = {
      ...base,
      kind: "disk-attached" as const,
      category: "storage" as const,
      severity: "info" as const,
    };
    expect(shouldToast(disk, preferences)).toBe(true);
    expect(shouldToast({ ...disk, kind: "disk-detached" }, preferences)).toBe(true);
    expect(shouldToast(disk, { ...preferences, toasts: false })).toBe(false);
    expect(shouldToast(disk, { ...preferences, mutedCategories: ["storage"] })).toBe(false);
    expect(shouldToast({ ...base, severity: "info" }, preferences)).toBe(false);
  });
});

it("opens EveryOS version notifications in Settings About and respects update-category toast preferences", () => {
  expect(
    notificationAction("everyos-update-available", ["system:read", "notifications:read"]),
  ).toEqual({ appId: "everyos.settings", appState: { section: "about" } });
  const update: NotificationView = {
    ...base,
    kind: "everyos-update-available",
    category: "updates",
    severity: "warning",
    params: { version: "0.1.7", installedVersion: "0.1.6" },
  };
  expect(shouldToast(update, preferences)).toBe(true);
  expect(shouldToast(update, { ...preferences, mutedCategories: ["updates"] })).toBe(false);
});
