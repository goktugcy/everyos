import { Button, errorMessage, useApp, useAsync, usePersistentState, useT } from "@everyos/app-ui";
import { NotebookPen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { NotesStore } from "./store.ts";

/** The quick-note widget: write a note without opening Notes, and jump to recent ones. */
export function QuickNote() {
  const app = useApp();
  const t = useT();
  const store = useMemo(() => new NotesStore(app), [app]);
  const [text, setText] = usePersistentState("widget/draft", "", { delayMs: 300 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const recent = useAsync(
    async () =>
      (await store.list())
        .filter((note) => note.deletedAt === null)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
        .slice(0, 5),
    [store],
  );
  const { reload } = recent;
  useEffect(() => app.lifecycle.onResume(reload), [app, reload]);

  const add = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await store.create({ text });
      setText("");
      setMessage(t("widget.saved"));
      reload();
    } catch (error) {
      setMessage(errorMessage(t, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="quick">
      <textarea
        className="quick-text"
        aria-label={t("widget.placeholder")}
        placeholder={t("widget.placeholder")}
        value={text}
        maxLength={20_000}
        onChange={(event) => {
          setText(event.target.value);
          setMessage("");
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void add();
          }
        }}
      />
      <div className="quick-actions">
        <span className="quick-message" role="status">
          {message}
        </span>
        <Button
          size="sm"
          variant="primary"
          disabled={!text.trim() || busy}
          onClick={() => void add()}
        >
          {t("widget.save")}
        </Button>
      </div>
      <section className="quick-recent" aria-label={t("widget.recent")}>
        <h2>{t("widget.recent")}</h2>
        {recent.data?.length ? (
          <ul>
            {recent.data.map((note) => (
              <li key={note.id}>
                <button type="button" onClick={() => void app.window.open({ noteId: note.id })}>
                  {note.title || t("list.untitled")}
                </button>
              </li>
            ))}
          </ul>
        ) : recent.data ? (
          <p>{t("widget.empty")}</p>
        ) : null}
      </section>
      <button type="button" className="quick-open" onClick={() => void app.window.open(null)}>
        <NotebookPen size={14} aria-hidden />
        {t("widget.open")}
      </button>
    </div>
  );
}
