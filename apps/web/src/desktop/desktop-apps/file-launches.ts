import type { FileLocation } from "../apps/files/lib.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import type { FileHandle } from "@everyos/app-sdk/protocol";
import { ApiRequestError } from "../../lib/api.ts";

/** Host-only selections: app-supplied window state can never authorize a file grant. */
export function createFileLaunches(session: () => string | null, now = Date.now) {
  const pending = new Map<
    string,
    {
      appId: string;
      requestId: string;
      sessionId: string;
      location: FileLocation;
      expiresAt: number;
    }
  >();
  return {
    queue(windowId: string, appId: string, requestId: string, location: FileLocation): void {
      const sessionId = session();
      if (!sessionId) return;
      for (const [id, entry] of pending)
        if (entry.expiresAt <= now() || entry.sessionId !== sessionId) pending.delete(id);
      if (pending.size >= 32) pending.delete(pending.keys().next().value!);
      pending.set(windowId, {
        appId,
        requestId,
        sessionId,
        location: { ...location },
        expiresAt: now() + 60_000,
      });
    },
    take(windowId: string, appId: string, requestId: string): FileLocation | null {
      const entry = pending.get(windowId);
      if (!entry) return null;
      if (entry.expiresAt <= now() || entry.sessionId !== session()) {
        pending.delete(windowId);
        return null;
      }
      if (entry.appId !== appId || entry.requestId !== requestId) return null;
      pending.delete(windowId);
      return entry.location;
    },
  };
}

export const fileLaunches = createFileLaunches(() => {
  const state = useSessionStore.getState();
  return state.locked ? null : (state.session?.session.id ?? null);
});

/** Resolve a trusted host selection into scoped handles, never forward its location to the app. */
export async function resolveFileLaunch(
  state: unknown,
  windowId: string,
  appId: string,
  grant: (location: FileLocation) => Promise<FileHandle[]>,
  launches = fileLaunches,
): Promise<unknown> {
  if (
    !state ||
    typeof state !== "object" ||
    !("type" in state) ||
    state.type !== "everyos.file-open"
  )
    return state;
  if (!("requestId" in state) || typeof state.requestId !== "string") return null;
  const location = launches.take(windowId, appId, state.requestId);
  if (!location) return null;
  try {
    return { type: "everyos.file-open", requestId: state.requestId, files: await grant(location) };
  } catch (error) {
    return {
      type: "everyos.file-open",
      requestId: state.requestId,
      error: error instanceof ApiRequestError ? error.code : "INTERNAL_ERROR",
    };
  }
}
