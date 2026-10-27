/**
 * Windows whose app wants a say before closing (a desktop app with unsaved work). Every way a
 * person closes a window goes through `requestClose`; an app closing itself does not.
 */
const guards = new Map<string, () => Promise<boolean>>();

export function setCloseGuard(windowId: string, guard: (() => Promise<boolean>) | null): void {
  if (guard) guards.set(windowId, guard);
  else guards.delete(windowId);
}

/** Runs `close` unless the window's app answers that it should stay open. */
export async function requestClose(windowId: string, close: () => void): Promise<void> {
  const guard = guards.get(windowId);
  if (guard) {
    let allowed: boolean;
    try {
      allowed = await guard();
    } catch {
      allowed = true;
    }
    if (!allowed) return;
  }
  guards.delete(windowId);
  close();
}
