import type { TrashListing } from "@everyos/shared";
import { createContext, useContext, type ReactNode } from "react";
import { useApiResource, type ApiResource } from "../../../features/system/use-api-resource.ts";
import { useSessionStore } from "../../../stores/session-store.ts";
import { useFilesRevision } from "./lib.ts";

const TrashContext = createContext<{ listing: ApiResource<TrashListing>; enabled: boolean } | null>(
  null,
);

/** One permissioned listing feeds every trash icon and the open Trash window. */
export function TrashStatusProvider({ children }: { children: ReactNode }) {
  const canRead = useSessionStore(
    (state) => state.session?.permissions.includes("files:read") ?? false,
  );
  const locked = useSessionStore((state) => state.locked);
  const revision = useFilesRevision();
  const enabled = canRead && !locked;
  const listing = useApiResource<TrashListing>(enabled ? "/files/trash" : null, 10_000, revision);
  return <TrashContext value={{ listing, enabled }}>{children}</TrashContext>;
}

export function useTrashListing(): ApiResource<TrashListing> {
  const value = useContext(TrashContext);
  if (!value) throw new Error("TrashStatusProvider is required");
  return value.listing;
}

export function useTrashIconState(): "full" | "empty" | "unknown" {
  const value = useContext(TrashContext);
  if (!value?.enabled || value.listing.error || !value.listing.data) return "unknown";
  if (value.listing.data.entries.length > 0) return "full";
  return value.listing.data.truncated ? "unknown" : "empty";
}
