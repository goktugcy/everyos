import type { FileArchiveListing, TransferView } from "@everyos/shared";
import { File, Folder, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { TransferRow } from "../../../features/transfers/storage-panel.tsx";
import { refreshTransfers, useTransfers } from "../../../features/transfers/transfers.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes } from "../../../lib/format.ts";
import { filesApi, nameOf, type FileLocation } from "./lib.ts";

export type ArchiveRequest = { id: string; location: FileLocation; writable: boolean } & (
  { mode: "compress"; paths: string[] } | { mode: "extract" }
);

function shortName(value: string): string {
  let result = "";
  for (const char of value) {
    if (new TextEncoder().encode(result + char).length > 200) break;
    result += char;
  }
  return result;
}

export function ArchiveDialog({
  request,
  onClose,
}: {
  request: ArchiveRequest | null;
  onClose: () => void;
}) {
  return request ? <ArchiveContents key={request.id} request={request} onClose={onClose} /> : null;
}

function ArchiveContents({ request, onClose }: { request: ArchiveRequest; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const extracting = request.mode === "extract";
  const [name, setName] = useState(() =>
    extracting
      ? shortName(nameOf(request.location.path).replace(/\.zip$/i, "")) ||
        t("files.archive.archiveName")
      : t("files.archive.archiveName") + ".zip",
  );
  const [listing, setListing] = useState<FileArchiveListing | null>(null);
  const [loading, setLoading] = useState(extracting);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [started, setStarted] = useState<TransferView | null>(null);
  const [search, setSearch] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const passwordMismatch = !extracting && password.length > 0 && password !== confirmation;
  const live = useTransfers((state) =>
    started ? state.server.find((transfer) => transfer.id === started.id) : undefined,
  );
  useEffect(() => {
    if (request.mode !== "extract") return;
    const controller = new AbortController();
    void filesApi
      .archive(request.location, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setListing(result);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [request]);
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const result =
        request.mode === "extract"
          ? await filesApi.extract(request.location, name.trim(), password || undefined)
          : await filesApi.compress(
              request.location,
              request.paths,
              /\.zip$/i.test(name.trim()) ? name.trim() : name.trim() + ".zip",
              password || undefined,
            );
      setStarted(result.transfer);
      setPassword("");
      setConfirmation("");
      await refreshTransfers();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };
  const matches =
    listing?.entries.filter((entry) =>
      entry.path.toLocaleLowerCase(i18n.language).includes(search.toLocaleLowerCase(i18n.language)),
    ) ?? [];
  const shown = matches.slice(0, 200);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t(extracting ? "files.archive.extractTitle" : "files.archive.compressTitle")}
      description={extracting ? nameOf(request.location.path) : undefined}
    >
      <div className="flex flex-col gap-4" data-testid="archive-dialog">
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        {loading ? (
          <div role="status" className="flex justify-center p-4">
            <Loader2 className="size-5 animate-spin" aria-label={t("common.loading")} />
          </div>
        ) : null}
        {listing ? (
          <>
            <p className="text-sm text-fg-muted">
              {t("files.archive.summary", {
                count: listing.entries.length,
                size: formatBytes(listing.bytes, i18n.language),
              })}
            </p>
            <input
              type="search"
              className="rounded-everyos-sm border border-line bg-hover/5 px-3 py-2 text-sm"
              aria-label={t("files.archive.search")}
              placeholder={t("files.archive.search")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <ul
              aria-label={t("files.archive.contents")}
              className="max-h-56 overflow-auto rounded-everyos-sm border border-line p-2 text-sm"
            >
              {shown.map((entry, index) => {
                const Icon = entry.type === "directory" ? Folder : File;
                return (
                  <li key={`${entry.path}-${index}`} className="flex items-center gap-2 py-1">
                    <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate" title={entry.path}>
                      {entry.path}
                    </span>
                    {entry.type === "file" ? (
                      <span className="shrink-0 tabular-nums text-fg-muted">
                        {formatBytes(entry.size, i18n.language)}
                      </span>
                    ) : null}
                  </li>
                );
              })}
              {!listing.entries.length ? (
                <li className="p-2 text-fg-muted">{t("files.archive.empty")}</li>
              ) : null}
            </ul>
            {matches.length > shown.length ? (
              <p className="text-xs text-fg-muted">
                {t("files.archive.shown", { shown: shown.length })}
              </p>
            ) : null}
          </>
        ) : null}
        {!started ? (
          <>
            <label className="flex flex-col gap-2 text-sm">
              {t(extracting ? "files.archive.folderLabel" : "files.archive.archiveLabel")}
              <input
                className="rounded-everyos-sm border border-line bg-hover/5 px-3 py-2"
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
                maxLength={255}
              />
            </label>
            {!extracting || listing?.encrypted ? (
              <>
                <label className="flex flex-col gap-2 text-sm">
                  {t(extracting ? "files.archive.password" : "files.archive.passwordOptional")}
                  <input
                    type="password"
                    autoComplete="off"
                    className="rounded-everyos-sm border border-line bg-hover/5 px-3 py-2"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      if (!event.target.value) setConfirmation("");
                    }}
                    maxLength={1024}
                    disabled={pending}
                  />
                </label>
                <p className="text-xs text-fg-muted">
                  {t(extracting ? "files.archive.encryptedHint" : "files.archive.encryptionHint")}
                </p>
                {!extracting && password ? (
                  <label className="flex flex-col gap-2 text-sm">
                    {t("files.archive.passwordConfirm")}
                    <input
                      type="password"
                      autoComplete="off"
                      className="rounded-everyos-sm border border-line bg-hover/5 px-3 py-2"
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      maxLength={1024}
                      disabled={pending}
                    />
                  </label>
                ) : null}
                {passwordMismatch && confirmation ? (
                  <Alert tone="danger">{t("files.archive.passwordMismatch")}</Alert>
                ) : null}
              </>
            ) : null}
            {!request.writable ? <Alert>{t("errors.FILES_READ_ONLY")}</Alert> : null}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button
                loading={pending}
                disabled={
                  !request.writable ||
                  !name.trim() ||
                  loading ||
                  passwordMismatch ||
                  (extracting && (!listing || (listing.encrypted && !password)))
                }
                onClick={() => void submit()}
              >
                {t(extracting ? "files.archive.extract" : "files.archive.create")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <ul aria-label={t("transfers.title")}>
              <TransferRow transfer={live ?? started} />
            </ul>
            {live?.state === "failed" || live?.state === "cancelled" ? (
              <Button variant="secondary" onClick={() => setStarted(null)}>
                {t("common.retry")}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}
