import type { DriveAccountView, DriveEntry, DriveListing, TransferView } from "@everyos/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { api, uploadWithProgress } from "../../lib/api.ts";
import { localTransfers } from "../transfers/transfers.ts";

/*
 * The person's Google Drive (docs/drive.md): connection state for the shell, and the Drive API
 * of EveryOS. Files never go from the browser to Google directly; EveryOS streams them.
 */

export const useDriveAccount = create<{
  view: DriveAccountView | null;
  /** Why finishing a consent that came back to this page failed. */
  error: unknown;
}>()(() => ({ view: null, error: null }));

export async function refreshDriveAccount(): Promise<DriveAccountView | null> {
  try {
    const view = await api<DriveAccountView>("/drive/account");
    useDriveAccount.setState({ view });
    return view;
  } catch {
    return null;
  }
}

/** Loads the connection state once per session (needs `files:read`). */
export function useDriveAccountLoader(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    void refreshDriveAccount();
    // Connecting may finish in another tab (Google's page returns there).
    const onFocus = () => void refreshDriveAccount();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      useDriveAccount.setState({ view: null });
    };
  }, [enabled]);
}

/**
 * Google's answer when it comes back to EveryOS itself (the browser runs on the server): the
 * connection is completed and the address cleaned up.
 */
export function useDriveConsentReturn(enabled: boolean, done: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.get("scope")?.includes("googleapis.com/auth/drive")) return;
    const answer = parseConsentAnswer(window.location.href);
    window.history.replaceState(null, "", window.location.pathname);
    if (!answer) return;
    void driveApi
      .complete(answer.code, answer.state)
      .catch((error: unknown) => useDriveAccount.setState({ error }))
      .finally(done);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the shell is ready
  }, [enabled]);
}

export const isDriveConnected = (view: DriveAccountView | null) =>
  view?.account?.status === "connected";

/**
 * Where Google sends the browser after consent. On the server itself that is EveryOS; elsewhere
 * a loopback port nothing listens on, whose address the person pastes back.
 */
export function redirectUri(): string {
  const { hostname, port, protocol } = window.location;
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(hostname) && protocol === "http:";
  return loopback ? `http://${hostname}:${port || "80"}/` : "http://127.0.0.1:53682/";
}

/** The code and state of Google's answer, from a pasted address or this page's own. */
export function parseConsentAnswer(text: string): { code: string; state: string } | null {
  try {
    const url = new URL(text.trim());
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    return code && state ? { code, state } : null;
  } catch {
    return null;
  }
}

export const driveApi = {
  list: (folder: string, pageToken?: string) =>
    api<DriveListing>(
      `/drive/files?${new URLSearchParams({ folder, ...(pageToken ? { pageToken } : {}) }).toString()}`,
    ),
  mkdir: (parent: string, name: string) =>
    api<DriveEntry>("/drive/folders", { method: "POST", body: { parent, name } }),
  rename: (id: string, name: string) =>
    api<DriveEntry>(`/drive/files/${id}`, { method: "PATCH", body: { name } }),
  trash: (id: string) => api(`/drive/files/${id}/trash`, { method: "POST", body: {} }),
  downloadUrl: (id: string) => `/api/drive/files/${id}/download`,
  /** A server-side copy between Drive and an EveryOS location, listed in transfers. */
  transfer: (
    source: { kind: "drive"; id: string } | { kind: "files"; root: string; path: string },
    destination: { kind: "drive"; id: string } | { kind: "files"; root: string; path: string },
  ) => api<TransferView>("/drive/transfers", { method: "POST", body: { source, destination } }),
  /** A file from this computer into a Drive folder, with its speed in the transfer list. */
  async upload(file: File, parent: string, to: string): Promise<void> {
    const controller = new AbortController();
    const transfer = localTransfers.start({
      id: crypto.randomUUID(),
      name: file.name,
      to,
      total: file.size,
      abort: () => controller.abort(),
    });
    try {
      await uploadWithProgress(
        `/drive/upload?${new URLSearchParams({ parent, name: file.name }).toString()}`,
        file,
        (loaded, total) => transfer.progress(loaded, total),
        controller.signal,
      );
      transfer.done();
    } catch (caught) {
      transfer.fail(
        caught instanceof DOMException && caught.name === "AbortError"
          ? "CANCELLED"
          : ((caught as { code?: string }).code ?? "UNKNOWN"),
      );
      throw caught;
    }
  },
  connect: (redirect: string) =>
    api<{ url: string }>("/drive/connect", { method: "POST", body: { redirectUri: redirect } }),
  complete: async (code: string, state: string) => {
    const view = await api<DriveAccountView>("/drive/connect/complete", {
      method: "POST",
      body: { code, state },
    });
    useDriveAccount.setState({ view });
    return view;
  },
  disconnect: async () => {
    await api("/drive/account", { method: "DELETE" });
    await refreshDriveAccount();
  },
};
