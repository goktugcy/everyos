import type { TransferView } from "@everyos/shared";
import { useEffect } from "react";
import { subscribeTopic } from "../../lib/event-stream.ts";
import { refreshTransfers, useTransfers } from "./transfers.ts";
import { filesChanged } from "../../desktop/apps/files/lib.ts";

/** Keeps the person's server transfers live while enabled (needs `files:read`). */
export function useTransfersStream(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const changes = useTransfers.subscribe((state, previous) => {
      if (
        state.server.some(
          (transfer) =>
            (transfer.direction === "compress" || transfer.direction === "extract") &&
            ["done", "failed", "cancelled"].includes(transfer.state) &&
            previous.server.find((old) => old.id === transfer.id)?.state !== transfer.state,
        )
      )
        filesChanged();
    });
    const unsubscribe = subscribeTopic("transfers", {
      ready: () => void refreshTransfers(),
      events: {
        transfers: (data) => useTransfers.setState({ server: data as TransferView[] }),
      },
    });
    return () => {
      unsubscribe();
      changes();
      useTransfers.setState({ server: [] });
    };
  }, [enabled]);
}
