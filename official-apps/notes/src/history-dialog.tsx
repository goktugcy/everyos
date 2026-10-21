import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  useAsync,
  useI18n,
  useT,
} from "@everyos/app-ui";
import { renderMarkdown } from "@everyos/app-ui/markdown";
import { useState } from "react";
import type { NoteMeta, NotesStore } from "./store.ts";

/** Earlier versions of a note, to read and bring back. */
export function HistoryDialog({
  open,
  store,
  note,
  onClose,
  onRestored,
}: {
  open: boolean;
  store: NotesStore;
  note: NoteMeta;
  onClose: () => void;
  onRestored: (text: string) => void;
}) {
  const t = useT();
  const i18n = useI18n();
  const versions = useAsync(
    () => (open ? store.revisions(note.id) : Promise.resolve([])),
    [open, note.id],
  );
  const [chosen, setChosen] = useState<number | null>(null);
  const list = versions.data ?? [];
  const current = list.find((entry) => entry.at === chosen) ?? list[0] ?? null;
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open={open}
      title={t("history.title")}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t("ui.close")}</Button>
          <Button
            variant="primary"
            disabled={!current || busy}
            onClick={() => {
              if (!current) return;
              setBusy(true);
              void store
                .restoreRevision(note.id, current.at)
                .then((text) => {
                  if (text !== null) onRestored(text);
                })
                .finally(() => setBusy(false));
            }}
          >
            {t("actions.restoreVersion")}
          </Button>
        </>
      }
    >
      {versions.loading ? (
        <LoadingState />
      ) : versions.error ? (
        <ErrorState error={versions.error} onRetry={versions.reload} />
      ) : list.length ? (
        <div className="notes-history">
          <ul className="eui-list notes-history-list" aria-label={t("history.title")}>
            {list.map((entry) => (
              <li key={entry.at}>
                <button
                  type="button"
                  className="eui-item"
                  aria-current={entry === current ? "true" : undefined}
                  onClick={() => setChosen(entry.at)}
                >
                  {i18n.date(entry.at, { dateStyle: "medium", timeStyle: "short" })}
                </button>
              </li>
            ))}
          </ul>
          <article
            className="notes-history-preview eui-markdown"
            // Sanitized by renderMarkdown (raw HTML off, DOMPurify).
            dangerouslySetInnerHTML={{ __html: current ? renderMarkdown(current.text) : "" }}
          />
        </div>
      ) : (
        <EmptyState title={t("history.empty")} />
      )}
    </Dialog>
  );
}
