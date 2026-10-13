import type { TrashListing } from "@everyos/shared";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { ApiRequestError } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { useApiResource, type ApiResource } from "../../../features/system/use-api-resource.ts";
import { useSessionStore } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { filesChanged, useFilesRevision } from "./lib.ts";
import { deleteTrashContents, IncompleteTrashListingError } from "./empty-trash.ts";

interface TrashContextValue {
  listing: ApiResource<TrashListing>;
  enabled: boolean;
  busy: boolean;
  empty: () => Promise<boolean>;
}
const TrashContext = createContext<TrashContextValue | null>(null);

/** One permissioned listing feeds every trash icon and the open Trash window. */
export function TrashStatusProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const sessionId = useSessionStore((state) => state.session?.session.id);
  const canRead = useSessionStore(
    (state) => state.session?.permissions.includes("files:read") ?? false,
  );
  const locked = useSessionStore((state) => state.locked);
  const revision = useFilesRevision();
  const enabled = canRead && !locked;
  const listing = useApiResource<TrashListing>(enabled ? "/files/trash" : null, 10_000, revision);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = async () => {
    if (running.current || !sessionId) return false;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      if (
        !(await requestConfirm({
          title: t("trash.emptyTitle"),
          body: t("trash.emptyBody"),
          confirmLabel: t("trash.emptyAction"),
          danger: true,
        }))
      )
        return false;
      await deleteTrashContents(() => {
        const current = useSessionStore.getState();
        if (current.session?.session.id !== sessionId || current.locked)
          throw new ApiRequestError(
            423,
            "SESSION_LOCKED",
            "The original session is no longer active",
          );
        if (
          !current.session.permissions.includes("files:write") ||
          !current.session.permissions.includes("files:read")
        )
          throw new ApiRequestError(403, "FORBIDDEN", "File access is required");
      });
      return true;
    } catch (caught) {
      setError(
        caught instanceof IncompleteTrashListingError
          ? t("trash.emptyIncomplete")
          : errorMessage(t, caught),
      );
      return false;
    } finally {
      running.current = false;
      setBusy(false);
      filesChanged();
    }
  };
  return (
    <TrashContext value={{ listing, enabled, busy, empty }}>
      {children}
      {enabled && error ? (
        <div
          className="fixed right-3 top-12 z-[8500] w-[min(360px,calc(100vw-24px))]"
          data-testid="trash-action-error"
        >
          <Alert tone="danger">
            <div className="flex items-start gap-3">
              <p className="flex-1">{error}</p>
              <button
                type="button"
                aria-label={t("common.close")}
                className="shrink-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onClick={() => setError(null)}
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          </Alert>
        </div>
      ) : null}
    </TrashContext>
  );
}

export function useTrashActions(): TrashContextValue {
  const value = useContext(TrashContext);
  if (!value) throw new Error("TrashStatusProvider is required");
  return value;
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
