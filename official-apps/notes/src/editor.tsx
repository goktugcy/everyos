import {
  Badge,
  Button,
  IconButton,
  Select,
  Tabs,
  TextField,
  saveTextFile,
  useApp,
  useI18n,
  useT,
  useToast,
} from "@everyos/app-ui";
import { renderMarkdown } from "@everyos/app-ui/markdown";
import {
  ArchiveRestore,
  ChevronLeft,
  Columns2,
  Copy,
  Eye,
  FileDown,
  History,
  PencilLine,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type RefObject } from "react";
import type { useDraft } from "./draft.ts";
import { TRASH_MS, normalizeTags, type NoteMeta } from "./store.ts";

export type Mode = "edit" | "split" | "preview";

/** Words as the language sees them (Chinese and Japanese have no spaces); Markdown marks are not. */
export function countWords(text: string, locale: string): number {
  if (typeof Intl.Segmenter === "function") {
    let count = 0;
    for (const segment of new Intl.Segmenter(locale, { granularity: "word" }).segment(text))
      if (segment.isWordLike) count += 1;
    return count;
  }
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
}

const fileName = (title: string, fallback: string) =>
  `${
    (title || fallback)
      .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
      .trim()
      .slice(0, 80) || fallback
  }.md`;

export function Editor({
  note,
  folders,
  draft,
  mode,
  editorRef,
  onBack,
  onMode,
  onUpdate,
  onDelete,
  onRestore,
  onDestroy,
  onHistory,
  onFailed,
}: {
  note: NoteMeta;
  folders: readonly string[];
  draft: ReturnType<typeof useDraft>;
  mode: Mode;
  editorRef: RefObject<HTMLTextAreaElement | null>;
  onBack: (() => void) | null;
  onMode: (mode: Mode) => void;
  onUpdate: (patch: Partial<Pick<NoteMeta, "folder" | "tags" | "pinned">>) => Promise<void>;
  onDelete: () => void;
  onRestore: () => void;
  onDestroy: () => void;
  onHistory: () => void;
  onFailed: (error: unknown) => void;
}) {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const [tags, setTags] = useState(note.tags.join(", "));
  useEffect(() => setTags(note.tags.join(", ")), [note.tags]);
  const html = useMemo(
    () => (mode === "edit" || !draft.loaded ? "" : renderMarkdown(draft.text)),
    [mode, draft.loaded, draft.text],
  );
  const words = useMemo(() => countWords(draft.text, i18n.tag), [draft.text, i18n.tag]);
  const trashed = note.deletedAt !== null;

  const commitTags = () => {
    const next = normalizeTags(tags);
    if (next.join(",") !== note.tags.join(",")) void onUpdate({ tags: next });
    else setTags(note.tags.join(", "));
  };
  const copy = async () => {
    try {
      await draft.flush();
      await app.clipboard.writeText(draft.text);
      toast(t("ui.copied"));
    } catch (error) {
      onFailed(error);
    }
  };
  const exportNote = async () => {
    try {
      await draft.flush();
      if (
        await saveTextFile(app, fileName(note.title, t("list.untitled")), draft.text, {
          accept: [".md"],
        })
      )
        toast(t("ui.exported"));
    } catch (error) {
      onFailed(error);
    }
  };

  const status =
    draft.status === "saving"
      ? t("editor.saving")
      : draft.status === "editing"
        ? t("editor.editing")
        : draft.status === "failed"
          ? t("editor.failed")
          : draft.status === "saved"
            ? t("editor.saved")
            : "";

  return (
    <div className="notes-editor-pane">
      <div className="notes-editor-bar" role="toolbar" aria-label={t("editor.tools")}>
        {onBack ? (
          <IconButton
            label={t("actions.back")}
            icon={<ChevronLeft size={16} aria-hidden />}
            onClick={onBack}
          />
        ) : null}
        {trashed ? (
          <>
            <Badge tone="warning">{t("views.trash")}</Badge>
            <span className="eui-spacer" />
            <Button icon={<ArchiveRestore size={15} aria-hidden />} onClick={onRestore}>
              {t("actions.restore")}
            </Button>
            <Button variant="danger" onClick={onDestroy}>
              {t("actions.deleteForever")}
            </Button>
          </>
        ) : (
          <>
            <Tabs<Mode>
              label={t("editor.modes")}
              value={mode}
              onChange={onMode}
              iconOnly
              tabs={[
                {
                  value: "edit",
                  label: t("editor.edit"),
                  icon: <PencilLine size={15} aria-hidden />,
                },
                {
                  value: "split",
                  label: t("editor.split"),
                  icon: <Columns2 size={15} aria-hidden />,
                },
                {
                  value: "preview",
                  label: t("editor.preview"),
                  icon: <Eye size={15} aria-hidden />,
                },
              ]}
            />
            <span className="eui-spacer" />
            <span
              className="notes-status"
              role="status"
              data-failed={draft.status === "failed" || undefined}
            >
              {status}
            </span>
            <IconButton
              label={note.pinned ? t("actions.unpin") : t("actions.pin")}
              pressed={note.pinned}
              icon={note.pinned ? <PinOff size={16} aria-hidden /> : <Pin size={16} aria-hidden />}
              onClick={() => void onUpdate({ pinned: !note.pinned })}
            />
            <IconButton
              label={t("actions.copy")}
              icon={<Copy size={16} aria-hidden />}
              onClick={() => void copy()}
            />
            <IconButton
              label={t("actions.exportNote")}
              icon={<FileDown size={16} aria-hidden />}
              onClick={() => void exportNote()}
            />
            <IconButton
              label={t("actions.history")}
              icon={<History size={16} aria-hidden />}
              onClick={onHistory}
            />
            <IconButton
              label={t("actions.delete")}
              icon={<Trash2 size={16} aria-hidden />}
              onClick={onDelete}
            />
          </>
        )}
      </div>
      {trashed ? (
        <p className="notes-trash-note">
          {t("editor.inTrash", {
            date: i18n.date((note.deletedAt ?? 0) + TRASH_MS, { dateStyle: "long" }),
          })}
        </p>
      ) : (
        <div className="notes-meta">
          <Select<string>
            label={t("editor.folder")}
            value={note.folder ?? ""}
            options={[
              { value: "", label: t("editor.noFolder") },
              ...folders.map((name) => ({ value: name, label: name })),
            ]}
            onChange={(folder) => void onUpdate({ folder: folder || null })}
          />
          <TextField
            label={t("editor.tags")}
            placeholder={t("editor.tagsHint")}
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            onBlur={commitTags}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitTags();
              }
            }}
          />
        </div>
      )}
      <div className="notes-editor-body" data-mode={trashed ? "preview" : mode}>
        {!trashed && mode !== "preview" ? (
          <textarea
            ref={editorRef}
            className="notes-textarea"
            aria-label={t("editor.label")}
            placeholder={t("editor.placeholder")}
            value={draft.text}
            disabled={!draft.loaded}
            spellCheck
            onChange={(event) => draft.setText(event.target.value)}
            onKeyDown={(event) => {
              // Tab indents instead of leaving the editor (Esc, then Tab, moves on).
              if (event.key !== "Tab" || event.shiftKey || event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              const element = event.currentTarget;
              const { selectionStart, selectionEnd, value } = element;
              draft.setText(`${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`);
              requestAnimationFrame(() =>
                element.setSelectionRange(selectionStart + 2, selectionStart + 2),
              );
            }}
          />
        ) : null}
        {trashed || mode !== "edit" ? (
          <article
            className="notes-preview eui-markdown"
            aria-label={t("editor.previewLabel")}
            // Sanitized by renderMarkdown (raw HTML off, DOMPurify).
            dangerouslySetInnerHTML={{ __html: trashed ? renderMarkdown(draft.text) : html }}
          />
        ) : null}
      </div>
      <div className="notes-footer">
        <span>{t("editor.words", { count: words })}</span>
        <span>
          {t("editor.edited", {
            date: i18n.date(note.updatedAt, { dateStyle: "medium", timeStyle: "short" }),
          })}
        </span>
      </div>
    </div>
  );
}
