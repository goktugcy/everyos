import { create } from "zustand";
import type { GridMetrics } from "../surface/icon-grid.ts";
import { useSessionStore } from "../../stores/session-store.ts";

export interface ShortcutDialogRequest {
  destination: "desktop" | "dock";
  desktopId?: string;
  metrics?: GridMetrics;
  appId?: string;
  shortcutId?: string;
}
export const useShortcutDialog = create<{
  request: ShortcutDialogRequest | null;
  sessionId: string | undefined;
}>()(() => ({ request: null, sessionId: undefined }));
export function openShortcutDialog(request: ShortcutDialogRequest): void {
  useShortcutDialog.setState({
    request,
    sessionId: useSessionStore.getState().session?.session.id,
  });
}
export function closeShortcutDialog(): void {
  useShortcutDialog.setState({ request: null });
}
