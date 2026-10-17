import type { TransferView } from "@everyos/shared";
import { useEffect } from "react";
import { subscribeTopic } from "../../lib/event-stream.ts";
import { refreshTransfers, useTransfers } from "./transfers.ts";

/** Keeps the person's server transfers live while enabled (needs `files:read`). */
export function useTransfersStream(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribeTopic("transfers", {
      ready: () => void refreshTransfers(),
      events: {
        transfers: (data) => useTransfers.setState({ server: data as TransferView[] }),
      },
    });
    return () => {
      unsubscribe();
      useTransfers.setState({ server: [] });
    };
  }, [enabled]);
}
