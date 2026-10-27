import type { FileHandle } from "@everyos/app-sdk";
import {
  Button,
  Dialog,
  EmptyState,
  errorMessage,
  IconButton,
  ListItem,
  LoadingState,
  Spacer,
  Tabs,
  Toolbar,
  ToolbarTitle,
  saveTextFile,
  useApp,
  useI18n,
  useNarrow,
  usePersistentState,
  useShortcuts,
  useT,
  useToast,
} from "@everyos/app-ui";
import { CodeEditor, EditorView } from "@everyos/app-ui/editor";
import { markdownHeadings, markdownTitle } from "@everyos/app-ui/markdown";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { openSearchPanel } from "@codemirror/search";
import {
  Clipboard,
  Columns2,
  Eye,
  FileCode2,
  FileDown,
  FilePlus,
  FolderOpen,
  History,
  ListTree,
  PencilLine,
  Save,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { exportHtml, renderPreview, textStats } from "./export.ts";

type Mode = "edit" | "split" | "preview";

interface Settings {
  mode: Mode;
  outline: boolean;
}

/** The document being edited, kept in storage so nothing typed is lost. */
interface Draft {
  name: string;
  handleId: string | null;
  text: string;
  /** The text as last read from or written to the file. */
  savedText: string;
}

const DRAFT_LIMIT = 200_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPT = [".md", ".markdown", ".mdown", ".txt"];
const markdownLanguage = markdown({ codeLanguages: languages });

export function MarkdownApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const narrow = useNarrow(760);
  const [settings, setSettings] = usePersistentState<Settings>("settings", {
    mode: "split",
    outline: true,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const view = useRef<EditorView | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;

  const fail = useCallback(
    (caught: unknown) => toast(errorMessage(t, caught), "danger"),
    [t, toast],
  );
  const untitled = t("doc.untitled");

  useEffect(() => {
    let stale = false;
    void app.storage
      .get<Draft>("draft")
      .then((stored) => {
        if (stale) return;
        setDraft(
          stored && typeof stored.text === "string"
            ? stored
            : { name: `${untitled}.md`, handleId: null, text: "", savedText: "" },
        );
      })
      .catch((caught: unknown) => {
        if (stale) return;
        setDraft({ name: `${untitled}.md`, handleId: null, text: "", savedText: "" });
        fail(caught);
      });
    return () => {
      stale = true;
    };
    // Once, at start.
  }, []);

  // Autosave of the draft (recovery after a reload or a crash).
  useEffect(() => {
    if (!draft) return;
    const timer = setTimeout(() => {
      if (draft.text.length > DRAFT_LIMIT) return;
      void app.storage.set("draft", draft).catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [app, draft]);

  const dirty = !!draft && draft.text !== draft.savedText;
  useEffect(() => {
    void app.lifecycle.guardClose(
      dirty
        ? () =>
            app.dialogs.confirm(t("close.title"), t("close.body"), {
              confirm: t("close.confirm"),
              destructive: true,
            })
        : null,
    );
  }, [app, dirty, t]);

  useEffect(() => {
    if (draft) void app.window.setTitle(`${dirty ? "• " : ""}${draft.name}`);
  }, [app, draft, dirty]);

  const html = useMemo(
    () => (draft && settings.mode !== "edit" ? renderPreview(draft.text) : ""),
    [draft, settings.mode],
  );
  const headings = useMemo(() => (draft ? markdownHeadings(draft.text) : []), [draft]);
  const stats = useMemo(() => textStats(draft?.text ?? ""), [draft?.text]);

  /** Leaving unsaved file changes asks first. */
  const replaceDocument = async (): Promise<boolean> => {
    const current = draftRef.current;
    if (!current || current.text === current.savedText) return true;
    return app.dialogs.confirm(t("replace.title", { name: current.name }), t("replace.body"), {
      confirm: t("replace.confirm"),
      destructive: true,
    });
  };

  const load = async (handle: FileHandle) => {
    if (handle.size !== null && handle.size > MAX_FILE_BYTES)
      throw new RangeError(`too-large:${MAX_FILE_BYTES}`);
    const text = (await app.files.readText(handle)).replace(/\r\n?/g, "\n");
    setDraft({ name: handle.name, handleId: handle.id, text, savedText: text });
  };

  const newDocument = async () => {
    if (!(await replaceDocument())) return;
    setDraft({ name: `${untitled}.md`, handleId: null, text: "", savedText: "" });
  };

  const open = async () => {
    try {
      if (!(await replaceDocument())) return;
      const [handle] = await app.files.open({
        accept: ACCEPT,
        persist: true,
        write: app.permissions.has("files:save"),
      });
      if (handle) await load(handle);
    } catch (caught) {
      fail(caught);
    }
  };

  const save = async (saveAs = false) => {
    const current = draftRef.current;
    if (!current) return;
    try {
      const existing =
        !saveAs && current.handleId
          ? ((await app.files.handles()).find((handle) => handle.id === current.handleId) ?? null)
          : null;
      const handle = existing?.writable
        ? existing
        : await app.files.save({ suggestedName: current.name, accept: [".md"], persist: true });
      if (!handle) return;
      await app.files.write(handle, current.text);
      setDraft((latest) =>
        latest
          ? { ...latest, name: handle.name, handleId: handle.id, savedText: current.text }
          : latest,
      );
      toast(t("save.saved", { name: handle.name }));
    } catch (caught) {
      fail(caught);
    }
  };

  const base = (draft?.name ?? untitled).replace(/\.(md|markdown|mdown|txt)$/i, "");
  const exportMarkdown = async () => {
    const draft = draftRef.current;
    if (!draft) return;
    try {
      if (await saveTextFile(app, `${base}.md`, draft.text, { accept: [".md"] }))
        toast(t("ui.exported"));
    } catch (caught) {
      fail(caught);
    }
  };
  const exportAsHtml = async () => {
    const draft = draftRef.current;
    if (!draft) return;
    try {
      const title = markdownTitle(draft.text, base);
      if (
        await saveTextFile(app, `${base}.html`, exportHtml(draft.text, title, i18n.locale), {
          accept: [".html"],
        })
      )
        toast(t("ui.exported"));
    } catch (caught) {
      fail(caught);
    }
  };
  const copyHtml = async () => {
    const draft = draftRef.current;
    if (!draft) return;
    try {
      await app.clipboard.writeText(renderPreview(draft.text));
      toast(t("ui.copied"));
    } catch (caught) {
      fail(caught);
    }
  };

  /** Moves the editor (and the preview) to a heading of the outline. */
  const goTo = (index: number) => {
    const heading = headings[index];
    const editor = view.current;
    if (heading && editor) {
      const line = editor.state.doc.line(heading.line + 1);
      editor.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: "start" }),
      });
      editor.focus();
    }
    preview.current
      ?.querySelectorAll("h1, h2, h3, h4, h5, h6")
      [index]?.scrollIntoView({ block: "start" });
  };

  const cycleMode = () =>
    setSettings((current) => ({
      ...current,
      mode: current.mode === "edit" ? "split" : current.mode === "split" ? "preview" : "edit",
    }));

  useShortcuts({
    "mod+n": () => void newDocument(),
    "mod+o": () => void open(),
    "mod+s": () => void save(),
    "mod+shift+s": () => void save(true),
    "mod+e": cycleMode,
  });

  if (!draft) return <LoadingState />;
  const mode = narrow && settings.mode === "split" ? "edit" : settings.mode;

  return (
    <div className="md-app">
      <Toolbar label={t("app.name")}>
        <ToolbarTitle>{draft.name}</ToolbarTitle>
        {dirty ? <span className="md-dirty">{t("status.unsaved")}</span> : null}
        <Spacer />
        <IconButton
          label={t("actions.new")}
          icon={<FilePlus size={16} aria-hidden />}
          onClick={() => void newDocument()}
        />
        <IconButton
          label={t("actions.open")}
          icon={<FolderOpen size={16} aria-hidden />}
          onClick={() => void open()}
        />
        <IconButton
          label={t("actions.recent")}
          icon={<History size={16} aria-hidden />}
          onClick={() => setRecentOpen(true)}
        />
        <IconButton
          label={t("actions.save")}
          icon={<Save size={16} aria-hidden />}
          onClick={() => void save()}
        />
        <Button size="sm" variant="ghost" onClick={() => void save(true)}>
          {t("actions.saveAs")}
        </Button>
        <IconButton
          label={t("actions.exportMarkdown")}
          icon={<FileDown size={16} aria-hidden />}
          onClick={() => void exportMarkdown()}
        />
        <IconButton
          label={t("actions.exportHtml")}
          icon={<FileCode2 size={16} aria-hidden />}
          onClick={() => void exportAsHtml()}
        />
        <IconButton
          label={t("actions.copyHtml")}
          icon={<Clipboard size={16} aria-hidden />}
          onClick={() => void copyHtml()}
        />
        <IconButton
          label={t("actions.find")}
          icon={<Search size={16} aria-hidden />}
          onClick={() => {
            if (settings.mode === "preview")
              setSettings((current) => ({ ...current, mode: "split" }));
            setTimeout(() => view.current && openSearchPanel(view.current), 0);
          }}
        />
        <IconButton
          label={t("actions.outline")}
          pressed={settings.outline}
          icon={<ListTree size={16} aria-hidden />}
          onClick={() => setSettings((current) => ({ ...current, outline: !current.outline }))}
        />
        <Tabs<Mode>
          label={t("modes.label")}
          value={settings.mode}
          iconOnly
          onChange={(next) => setSettings((current) => ({ ...current, mode: next }))}
          tabs={[
            { value: "edit", label: t("modes.edit"), icon: <PencilLine size={15} aria-hidden /> },
            { value: "split", label: t("modes.split"), icon: <Columns2 size={15} aria-hidden /> },
            { value: "preview", label: t("modes.preview"), icon: <Eye size={15} aria-hidden /> },
          ]}
        />
      </Toolbar>
      <div className="md-body" data-outline={settings.outline && !narrow ? true : undefined}>
        {settings.outline && !narrow ? (
          <nav className="md-outline" aria-label={t("outline.title")}>
            <h2>{t("outline.title")}</h2>
            {headings.length ? (
              <ul>
                {headings.map((heading, index) => (
                  <li
                    key={`${heading.line}-${heading.text}`}
                    style={{ paddingInlineStart: (heading.level - 1) * 12 }}
                  >
                    <button type="button" onClick={() => goTo(index)} data-level={heading.level}>
                      {heading.text}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="eui-hint">{t("outline.empty")}</p>
            )}
          </nav>
        ) : null}
        <div className="md-panes" data-mode={mode}>
          <div className="md-editor" hidden={mode === "preview"}>
            <CodeEditor
              value={draft.text}
              language={markdownLanguage}
              label={t("editor.label")}
              setup={{
                gutters: false,
                wrap: true,
                tabIndents: true,
                placeholder: t("editor.placeholder"),
              }}
              onChange={(text) => {
                // The ref follows at once, so actions right after typing see the new text.
                if (!draftRef.current) return;
                draftRef.current = { ...draftRef.current, text };
                setDraft(draftRef.current);
              }}
              onView={(editor) => {
                view.current = editor;
              }}
            />
          </div>
          {mode !== "edit" ? (
            <article
              ref={preview}
              className="md-preview eui-markdown"
              aria-label={t("modes.preview")}
              // Sanitized by renderMarkdown (raw HTML off, DOMPurify).
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : null}
        </div>
      </div>
      <footer className="md-status" aria-label={t("status.label")}>
        <span>{t("status.words", { count: stats.words })}</span>
        <span>{t("status.characters", { count: stats.characters })}</span>
        <span>{t("status.reading", { count: stats.minutes })}</span>
        {draft.text.length > DRAFT_LIMIT ? (
          <span className="md-warning">{t("status.noRecovery")}</span>
        ) : null}
      </footer>
      <RecentDialog
        open={recentOpen}
        onClose={() => setRecentOpen(false)}
        onOpen={async (handle) => {
          setRecentOpen(false);
          try {
            if (await replaceDocument()) await load(handle);
          } catch (caught) {
            fail(caught);
          }
        }}
      />
    </div>
  );
}

function RecentDialog({
  open,
  onClose,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (handle: FileHandle) => void;
}) {
  const app = useApp();
  const t = useT();
  const [handles, setHandles] = useState<FileHandle[] | null>(null);
  useEffect(() => {
    if (!open) return;
    setHandles(null);
    void app.files
      .handles()
      .then((list) => setHandles(list.filter((handle) => handle.kind === "file")))
      .catch(() => setHandles([]));
  }, [app, open]);
  return (
    <Dialog
      open={open}
      title={t("actions.recent")}
      onClose={onClose}
      actions={<Button onClick={onClose}>{t("ui.close")}</Button>}
    >
      {handles === null ? (
        <LoadingState />
      ) : handles.length ? (
        <ul className="eui-list md-recent">
          {handles.map((handle) => (
            <li key={handle.id}>
              <ListItem title={handle.name} onClick={() => onOpen(handle)} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t("recent.empty")} />
      )}
    </Dialog>
  );
}
