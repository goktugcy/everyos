import type { BootstrapResponse, SessionInfo } from "@otuken/shared";
import { create } from "zustand";
import { applyLocale } from "../app/i18n.ts";
import { api, ApiRequestError, onUnauthenticated, setCsrfToken } from "../lib/api.ts";

export type SessionPhase = "booting" | "unreachable" | "setup" | "login" | "authenticated";

interface SessionState {
  phase: SessionPhase;
  bootstrap: BootstrapResponse | null;
  session: SessionInfo | null;
  boot: () => Promise<void>;
  setSession: (session: SessionInfo) => void;
  updateUser: (user: SessionInfo["user"]) => void;
  signOut: () => Promise<void>;
  sessionEnded: () => void;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  phase: "booting",
  bootstrap: null,
  session: null,

  boot: async () => {
    set({ phase: "booting" });
    let bootstrap: BootstrapResponse;
    try {
      bootstrap = await api<BootstrapResponse>("/bootstrap");
    } catch {
      set({ phase: "unreachable" });
      return;
    }
    set({ bootstrap });
    if (bootstrap.setupRequired) {
      set({ phase: "setup" });
      return;
    }
    try {
      get().setSession(await api<SessionInfo>("/auth/session", { quiet401: true }));
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401)
        set({ phase: "login", session: null });
      else set({ phase: "unreachable" });
    }
  },

  setSession: (session) => {
    setCsrfToken(session.csrfToken);
    applyLocale(session.user.locale);
    set({ session, phase: "authenticated" });
  },

  updateUser: (user) => {
    const session = get().session;
    if (!session) return;
    applyLocale(user.locale);
    set({ session: { ...session, user } });
  },

  signOut: async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      setCsrfToken(null);
      set({ session: null, phase: "login" });
    }
  },

  sessionEnded: () => {
    setCsrfToken(null);
    if (get().phase === "authenticated") set({ session: null, phase: "login" });
  },
}));

onUnauthenticated(() => useSessionStore.getState().sessionEnded());

export function useHasPermission(permission: SessionInfo["permissions"][number]): boolean {
  return useSessionStore((state) => state.session?.permissions.includes(permission) ?? false);
}
