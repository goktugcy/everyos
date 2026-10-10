import type { BootstrapResponse, Permission, SessionInfo } from "@otuken/shared";
import { create } from "zustand";
import { applyLocale } from "../app/i18n.ts";
import {
  api,
  ApiRequestError,
  onSessionLocked,
  onUnauthenticated,
  setCsrfToken,
} from "../lib/api.ts";

const beforeSignOut = new Set<() => Promise<void>>();

/** Work to finish while the session is still valid (e.g. saving the desktop layout). */
export function registerBeforeSignOut(hook: () => Promise<void>): () => void {
  beforeSignOut.add(hook);
  return () => beforeSignOut.delete(hook);
}

export type SessionPhase = "booting" | "unreachable" | "setup" | "login" | "authenticated";

interface SessionState {
  phase: SessionPhase;
  bootstrap: BootstrapResponse | null;
  session: SessionInfo | null;
  /** The server-side lock state of the current session. */
  locked: boolean;
  boot: () => Promise<void>;
  setSession: (session: SessionInfo) => void;
  updateUser: (user: SessionInfo["user"]) => void;
  lock: () => Promise<void>;
  unlock: (password: string) => Promise<void>;
  markLocked: () => void;
  signOut: () => Promise<void>;
  sessionEnded: () => void;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  phase: "booting",
  bootstrap: null,
  session: null,
  locked: false,

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
    set({ session, phase: "authenticated", locked: session.session.locked });
  },

  updateUser: (user) => {
    const session = get().session;
    if (!session) return;
    applyLocale(user.locale);
    set({ session: { ...session, user } });
  },

  lock: async () => {
    if (get().locked) return;
    await api("/auth/lock", { method: "POST" });
    set({ locked: true });
  },

  unlock: async (password) => {
    get().setSession(
      await api<SessionInfo>("/auth/unlock", { method: "POST", body: { password } }),
    );
  },

  markLocked: () => {
    if (get().phase === "authenticated") set({ locked: true });
  },

  signOut: async () => {
    try {
      await Promise.allSettled([...beforeSignOut].map((hook) => hook()));
      await api("/auth/logout", { method: "POST" });
    } finally {
      setCsrfToken(null);
      set({ session: null, phase: "login", locked: false });
    }
  },

  sessionEnded: () => {
    setCsrfToken(null);
    if (get().phase === "authenticated") set({ session: null, phase: "login", locked: false });
  },
}));

onUnauthenticated(() => useSessionStore.getState().sessionEnded());
onSessionLocked(() => useSessionStore.getState().markLocked());

const NO_PERMISSIONS: readonly Permission[] = [];

/** The signed-in user's permissions (stable reference while unchanged). */
export function usePermissions(): readonly Permission[] {
  return useSessionStore((state) => state.session?.permissions ?? NO_PERMISSIONS);
}

export function useHasPermission(permission: Permission): boolean {
  return useSessionStore((state) => state.session?.permissions.includes(permission) ?? false);
}

export function hasPermission(permission: Permission): boolean {
  return useSessionStore.getState().session?.permissions.includes(permission) ?? false;
}
