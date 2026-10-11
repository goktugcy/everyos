import type { TextFile } from "@everyos/shared";
import { RotateCcw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { ApiRequestError } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { useAppHost } from "../app-context.ts";
import { filesApi, nameOf, type FileLocation } from "./lib.ts";

/** Plain text editor for files inside a configured root (up to 1 MiB of UTF-8). */
export default function EditorApp() {
  const { t, i18n } = useTranslation();
  const host = useAppHost();
  const location = host.appState as FileLocation | undefined;
  const canWrite = usePermissions().includes("files:write");
  const [file, setFile] = useState<TextFile | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(!canWrite);
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = file !== null && content !== file.content;
  const name = location ? nameOf(location.path) : "";

  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!location) return;
    let cancelled = false;
    Promise.all([filesApi.readText(location), filesApi.roots()]).then(
      ([loaded, { roots }]) => {
        if (cancelled) return;
        setError(null);
        setFile(loaded);
        setContent(loaded.content);
        setReadOnly(!canWrite || Boolean(roots.find((r) => r.id === location.root)?.readOnly));
      },
      (caught: unknown) => {
        if (!cancelled) setError(caught);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the location's fields identify it
  }, [location?.root, location?.path, canWrite, reload]);

  useEffect(() => {
    host.setTitle(`${dirty ? "• " : ""}${name}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- title follows the state
  }, [dirty, name]);

  const save = async (force = false) => {
    if (!location || !file || readOnly || saving) return;
    setSaving(true);
    setError(null);
    try {
      // Overwriting after a conflict uses the current version on disk.
      const etag = force ? (await filesApi.readText(location)).etag : file.etag;
      const saved = await filesApi.writeText(location, content, etag);
      setFile({ ...saved, content });
      setNotice(t("files.editor.saved"));
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code === "CONFLICT") {
        const overwrite = await requestConfirm({
          title: t("files.editor.conflictTitle"),
          body: t("files.editor.conflictBody", { name }),
          confirmLabel: t("files.editor.overwrite"),
          danger: true,
        });
        setSaving(false);
        if (overwrite) await save(true);
        return;
      }
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2_500);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!location) return <p className="p-6 text-sm text-fg-muted">{t("files.editor.noFile")}</p>;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="editor-app">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={readOnly || !dirty}
          loading={saving}
        >
          <Save className="size-4" aria-hidden />
          {t("files.editor.save")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!dirty}
          onClick={async () => {
            const ok = await requestConfirm({
              title: t("files.editor.revertTitle"),
              body: t("files.editor.revertBody"),
              confirmLabel: t("files.editor.revert"),
            });
            if (ok) setReload((n) => n + 1);
          }}
        >
          <RotateCcw className="size-4" aria-hidden />
          {t("files.editor.revert")}
        </Button>
        <span className="ml-auto truncate text-xs text-fg-muted" role="status">
          {notice ??
            (readOnly ? t("files.editor.readOnly") : dirty ? t("files.editor.unsaved") : "")}
        </span>
        {file ? (
          <span className="text-xs text-fg-subtle">
            {formatBytes(new TextEncoder().encode(content).length, i18n.language)}
          </span>
        ) : null}
      </div>
      {error ? (
        <div className="p-3">
          <Alert tone="danger">{errorMessage(t, error)}</Alert>
        </div>
      ) : null}
      {file ? (
        <textarea
          ref={area}
          value={content}
          readOnly={readOnly}
          spellCheck={false}
          aria-label={t("files.editor.label", { name })}
          className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[0.8rem] leading-relaxed text-fg outline-none"
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void save();
            } else if (event.key === "Tab" && !readOnly) {
              // Tab inserts indentation instead of leaving the editor (Esc then Tab leaves).
              event.preventDefault();
              const el = event.currentTarget;
              const { selectionStart, selectionEnd } = el;
              const next = `${content.slice(0, selectionStart)}  ${content.slice(selectionEnd)}`;
              setContent(next);
              requestAnimationFrame(() =>
                el.setSelectionRange(selectionStart + 2, selectionStart + 2),
              );
            } else if (event.key === "Escape") {
              event.currentTarget.blur();
            }
          }}
        />
      ) : null}
    </div>
  );
}
