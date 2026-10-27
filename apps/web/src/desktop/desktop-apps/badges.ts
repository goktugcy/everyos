import { create } from "zustand";

/**
 * Badges and attention requests of desktop app windows (the dock shows them). Kept per window so
 * closing a window clears its own badge only.
 */
interface BadgeState {
  /** appId → windowId → count. */
  badges: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** appIds that asked for attention until one of their windows is focused. */
  attention: ReadonlySet<string>;
  setBadge(appId: string, windowId: string | null, count: number | null): void;
  requestAttention(appId: string, windowId: string | null): void;
  clear(appId: string, windowId: string | null): void;
  acknowledge(appId: string): void;
}

const key = (windowId: string | null) => windowId ?? "widget";

export const useAppBadges = create<BadgeState>()((set) => ({
  badges: {},
  attention: new Set(),
  setBadge: (appId, windowId, count) =>
    set((state) => {
      const forApp = { ...state.badges[appId] };
      if (count === null || count === 0) delete forApp[key(windowId)];
      else forApp[key(windowId)] = count;
      return { badges: { ...state.badges, [appId]: forApp } };
    }),
  requestAttention: (appId) => set((state) => ({ attention: new Set(state.attention).add(appId) })),
  clear: (appId, windowId) =>
    set((state) => {
      const forApp = { ...state.badges[appId] };
      delete forApp[key(windowId)];
      return { badges: { ...state.badges, [appId]: forApp } };
    }),
  acknowledge: (appId) =>
    set((state) => {
      if (!state.attention.has(appId)) return state;
      const attention = new Set(state.attention);
      attention.delete(appId);
      return { attention };
    }),
}));

/** The total badge count an app shows across its windows. */
export function badgeCount(state: Pick<BadgeState, "badges">, appId: string): number {
  return Object.values(state.badges[appId] ?? {}).reduce((sum, count) => sum + count, 0);
}
