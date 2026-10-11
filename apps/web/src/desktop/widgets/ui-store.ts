import type { IntegrationAdapter, LocalizedText, WidgetPlacement } from "@everyos/shared";
import { create } from "zustand";

/** An installed app whose widgets the user may want to add ("Available widgets…"). */
export interface WidgetOffer {
  appId: string;
  name: LocalizedText;
  adapters: IntegrationAdapter[];
  /** Address the EveryOS server can reach the app at (pre-fills a new connection). */
  baseUrl: string | null;
}

interface WidgetUiState {
  gallery: { open: boolean; placement: WidgetPlacement; category: string | null };
  /** Instance whose configuration dialog is open. */
  configuring: string | null;
  offer: WidgetOffer | null;
  /** Short feedback such as "no free space" (auto-dismissed). */
  notice: string | null;
}

export const useWidgetUi = create<WidgetUiState>()(() => ({
  gallery: { open: false, placement: "desktop", category: null },
  configuring: null,
  offer: null,
  notice: null,
}));

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

export const widgetUi = {
  openGallery(placement: WidgetPlacement = "desktop", category: string | null = null): void {
    useWidgetUi.setState({ gallery: { open: true, placement, category }, offer: null });
  },
  closeGallery(): void {
    useWidgetUi.setState((state) => ({ gallery: { ...state.gallery, open: false } }));
  },
  configure(id: string | null): void {
    useWidgetUi.setState({ configuring: id });
  },
  offer(offer: WidgetOffer | null): void {
    useWidgetUi.setState({ offer });
  },
  notify(notice: string): void {
    if (noticeTimer) clearTimeout(noticeTimer);
    useWidgetUi.setState({ notice });
    noticeTimer = setTimeout(() => useWidgetUi.setState({ notice: null }), 5_000);
  },
};
