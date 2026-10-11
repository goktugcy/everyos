import type { FileEntry, FileRootView } from "@everyos/shared";
import { useEffect, useState } from "react";
import { usePermissions } from "../../stores/session-store.ts";
import { filesApi, useFilesRevision, type FileLocation } from "../apps/files/lib.ts";

/** Changes made outside this tab (a terminal, another browser) show up within this time. */
const POLL_MS = 20_000;
/** More icons than this do not fit any screen; the Desktop folder in Files shows them all. */
const MAX_SHOWN = 300;

export interface DesktopFolder {
  /** "unavailable": no files permission, homes turned off, or the folder cannot be read. */
  status: "loading" | "ready" | "unavailable";
  location: FileLocation | null;
  /** A new array whenever the folder's contents change. */
  entries: readonly FileEntry[];
  writable: boolean;
}

const NO_ENTRIES: readonly FileEntry[] = [];

const sameEntries = (a: readonly FileEntry[], b: readonly FileEntry[]) =>
  a.length === b.length &&
  a.every(
    (entry, index) =>
      entry.name === b[index]!.name &&
      entry.type === b[index]!.type &&
      entry.size === b[index]!.size &&
      entry.modifiedAt === b[index]!.modifiedAt,
  );

/**
 * The home's Desktop folder, whose entries the desktop shows like macOS. It is
 * listed again after every change made in this tab, on focus and every 20 s
 * while the page is visible.
 */
export function useDesktopFolder(): DesktopFolder {
  const permissions = usePermissions();
  const canRead = permissions.includes("files:read");
  const canWrite = permissions.includes("files:write");
  const changes = useFilesRevision();
  const [home, setHome] = useState<FileRootView | null | undefined>(undefined);
  const [entries, setEntries] = useState<readonly FileEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    filesApi.roots().then(
      (value) => {
        if (cancelled) return;
        const found = value.roots.find(
          (root) => root.kind === "home" && root.available && root.folders?.desktop,
        );
        setHome(found ?? null);
      },
      () => !cancelled && setHome(null),
    );
    return () => {
      cancelled = true;
    };
  }, [canRead]);

  const root = home?.id;
  const path = home?.folders?.desktop;

  useEffect(() => {
    if (!root || !path) return;
    const poll = () => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    };
    const timer = window.setInterval(poll, POLL_MS);
    window.addEventListener("focus", poll);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", poll);
    };
  }, [root, path]);

  useEffect(() => {
    if (!root || !path) return;
    let cancelled = false;
    filesApi.list({ root, path }).then(
      (listing) => {
        if (cancelled) return;
        const next = listing.entries.slice(0, MAX_SHOWN);
        setEntries((current) => (current && sameEntries(current, next) ? current : next));
        setFailed(false);
      },
      // A failed refresh keeps what is shown (and the icons' stored places).
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [root, path, changes, tick]);

  if (!canRead)
    return { status: "unavailable", location: null, entries: NO_ENTRIES, writable: false };
  if (home === undefined)
    return { status: "loading", location: null, entries: NO_ENTRIES, writable: false };
  if (!home || !path)
    return { status: "unavailable", location: null, entries: NO_ENTRIES, writable: false };
  const location = { root: home.id, path };
  if (!entries)
    return {
      status: failed ? "unavailable" : "loading",
      location,
      entries: NO_ENTRIES,
      writable: false,
    };
  return { status: "ready", location, entries, writable: canWrite && !home.readOnly };
}
