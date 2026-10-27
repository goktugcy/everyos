import type { FileHandle } from "@everyos/app-sdk";
import {
  Button,
  Dialog,
  EmptyState,
  errorMessage,
  IconButton,
  ListItem,
  LoadingState,
  Select,
  Spacer,
  Toolbar,
  ToolbarTitle,
  useApp,
  useI18n,
  usePersistentState,
  useShortcuts,
  useT,
  useToast,
} from "@everyos/app-ui";
import { CodeEditor, EditorView } from "@everyos/app-ui/editor";
import { gotoLine, openSearchPanel } from "@codemirror/search";
import { FilePlus, FolderOpen, History, Save, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatOf, isDirty, MAX_FILE_BYTES, newDoc, Recovery, type Doc } from "./documents.ts";
import {
  BinaryFileError,
  canWrite,
  decode,
  encode,
  ENCODINGS,
  fallbackEncoding,
  UnencodableError,
  type Encoding,
  type LineEnding,
} from "./encoding.ts";

interface Settings {
  lineNumbers: boolean;
  wrap: boolean;
}

interface Cursor {
  line: number;
  column: number;
  selected: number;
}

const ACCEPT = [
  ".txt",
  ".text",
  ".log",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".yml",
  ".yaml",
  ".ini",
  ".conf",
  ".cfg",
  ".env",
  ".sh",
  ".js",
  ".ts",
  ".css",
  ".html",
  ".sql",
  ".srt",
  ".vtt",
];

/** A tab for a file that was just read. */
function fromFile(
  handle: FileHandle,
  decoded: { text: string; encoding: Encoding; bom: boolean; eol: LineEnding },
): Doc {
  const doc = newDoc(handle.name, decoded.encoding);
  return {
    ...doc,
    handleId: handle.id,
    text: decoded.text,
    savedText: decoded.text,
    bom: decoded.bom,
    eol: decoded.eol,
    savedFormat: formatOf(decoded),
  };
}

function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
}

export function TextApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const recovery = useMemo(() => new Recovery(app), [app]);
  const [settings, setSettings] = usePersistentState<Settings>("settings", {
    lineNumbers: true,
    wrap: true,
  });
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Cursor>({ line: 1, column: 1, selected: 0 });
  const [encodingDialog, setEncodingDialog] = useState<"reopen" | "save" | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const views = useRef(new Map<string, EditorView>());
  const docsRef = useRef<Doc[]>([]);
  docsRef.current = docs ?? [];
  const fallback = fallbackEncoding(i18n.tag);

  const fail = useCallback(
    (caught: unknown) => toast(errorMessage(t, caught), "danger"),
    [t, toast],
  );

  const readHandle = useCallback(
    async (handle: FileHandle, forced?: Encoding) => {
      if (handle.size !== null && handle.size > MAX_FILE_BYTES)
        throw new RangeError(`too-large:${MAX_FILE_BYTES}`);
      return decode(new Uint8Array(await app.files.read(handle)), fallback, forced);
    },
    [app, fallback],
  );

  // Restore the last session's tabs.
  useEffect(() => {
    let stale = false;
    void recovery
      .restore(async (handle, meta) => readHandle(handle, meta.encoding))
      .then(({ docs: restored, active: activeId, lost }) => {
        if (stale) return;
        setDocs(restored.length ? restored : [newDoc(t("doc.untitled", { number: 1 }))]);
        setActive(activeId ?? null);
        if (lost.length) toast(t("recovery.lost", { names: lost.join(", ") }), "danger");
      })
      .catch((caught: unknown) => {
        if (stale) return;
        setDocs([newDoc(t("doc.untitled", { number: 1 }))]);
        fail(caught);
      });
    return () => {
      stale = true;
    };
    // Only once, at start.
  }, []);

  const current = docs?.find((doc) => doc.id === active) ?? docs?.[0] ?? null;

  // Recovery copies follow the tabs (debounced).
  useEffect(() => {
    if (!docs) return;
    const timer = setTimeout(() => {
      void recovery.saveIndex(docs, current?.id ?? null).catch(() => undefined);
      for (const doc of docs) void recovery.saveDoc(doc).catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [docs, current?.id, recovery]);

  // Closing the window with unsaved files asks first (recovery copies are kept either way).
  useEffect(() => {
    const dirty = (docs ?? []).filter(isDirty);
    void app.lifecycle.guardClose(
      dirty.length
        ? () =>
            app.dialogs.confirm(t("close.title", { count: dirty.length }), t("close.body"), {
              confirm: t("close.confirm"),
              destructive: true,
            })
        : null,
    );
  }, [app, docs, t]);

  useEffect(() => {
    if (current) void app.window.setTitle(`${isDirty(current) ? "• " : ""}${current.name}`);
  }, [app, current]);

  const update = (id: string, patch: Partial<Doc>) =>
    setDocs((list) => list?.map((doc) => (doc.id === id ? { ...doc, ...patch } : doc)) ?? list);

  const addDocs = (added: Doc[]) => {
    if (!added.length) return;
    setDocs((list) => {
      const existing = list ?? [];
      // A single empty, unchanged untitled tab gives way to opened files.
      const keep = existing.filter((doc) => doc.handleId || doc.text || isDirty(doc));
      return [...keep, ...added];
    });
    setActive(added.at(-1)!.id);
  };

  const newTab = () => {
    const doc = newDoc(t("doc.untitled", { number: (docs?.length ?? 0) + 1 }));
    setDocs((list) => [...(list ?? []), doc]);
    setActive(doc.id);
  };

  const openFiles = async () => {
    try {
      const write = app.permissions.has("files:save");
      const handles = await app.files.open({
        accept: ACCEPT,
        multiple: true,
        persist: true,
        write,
      });
      const opened: Doc[] = [];
      for (const handle of handles) {
        const already = docsRef.current.find((doc) => doc.handleId === handle.id);
        if (already) {
          setActive(already.id);
          continue;
        }
        try {
          const decoded = await readHandle(handle);
          opened.push(fromFile(handle, decoded));
        } catch (caught) {
          toast(
            caught instanceof BinaryFileError
              ? t("open.binary", { name: handle.name })
              : errorMessage(t, caught),
            "danger",
          );
        }
      }
      addDocs(opened);
    } catch (caught) {
      fail(caught);
    }
  };

  const openRecent = async (handle: FileHandle) => {
    setRecentOpen(false);
    const already = docsRef.current.find((doc) => doc.handleId === handle.id);
    if (already) return setActive(already.id);
    try {
      addDocs([fromFile(handle, await readHandle(handle))]);
    } catch (caught) {
      fail(caught);
    }
  };

  /** Writes `doc` to its file (or asks where); returns false when it was not saved. */
  const save = async (doc: Doc, saveAs = false): Promise<boolean> => {
    let encoding = doc.encoding;
    if (!canWrite(encoding)) {
      encoding = "utf-8";
      toast(t("save.convertedToUtf8", { encoding: doc.encoding.toUpperCase() }));
    }
    let bytes: Uint8Array;
    try {
      bytes = encode(doc.text, encoding, encoding === doc.encoding && doc.bom, doc.eol);
    } catch (caught) {
      if (caught instanceof UnencodableError) {
        toast(
          t("save.unencodable", {
            char: caught.char,
            line: caught.line,
            encoding: encoding.toUpperCase(),
          }),
          "danger",
        );
        setEncodingDialog("save");
        return false;
      }
      throw caught;
    }
    try {
      let handle =
        !saveAs && doc.handleId
          ? ((await app.files.handles()).find((entry) => entry.id === doc.handleId) ?? null)
          : null;
      if (!handle || !handle.writable) {
        handle = await app.files.save({ suggestedName: doc.name, persist: true });
        if (!handle) return false;
      }
      await app.files.write(handle, bytes);
      const bom = encoding === doc.encoding && doc.bom;
      update(doc.id, {
        handleId: handle.id,
        name: handle.name,
        savedText: doc.text,
        encoding,
        bom,
        savedFormat: formatOf({ encoding, bom, eol: doc.eol }),
      });
      toast(t("save.saved", { name: handle.name }));
      return true;
    } catch (caught) {
      fail(caught);
      return false;
    }
  };

  const closeTab = async (doc: Doc) => {
    if (isDirty(doc)) {
      const keep = !(await app.dialogs.confirm(
        t("close.tabTitle", { name: doc.name }),
        t("close.tabBody"),
        { confirm: t("close.discard"), destructive: true },
      ));
      if (keep) return;
    }
    views.current.delete(doc.id);
    void recovery.forget(doc.id).catch(() => undefined);
    setDocs((list) => {
      const next = (list ?? []).filter((entry) => entry.id !== doc.id);
      if (active === doc.id) setActive(next.at(-1)?.id ?? null);
      return next.length ? next : [newDoc(t("doc.untitled", { number: 1 }))];
    });
  };

  const reopenWith = async (encoding: Encoding) => {
    setEncodingDialog(null);
    if (!current) return;
    if (!current.handleId) return update(current.id, { encoding, bom: false });
    if (
      isDirty(current) &&
      !(await app.dialogs.confirm(t("encoding.reopenTitle"), t("encoding.reopenBody"), {
        confirm: t("encoding.reopen"),
        destructive: true,
      }))
    )
      return;
    try {
      const handle = (await app.files.handles()).find((entry) => entry.id === current.handleId);
      if (!handle) throw new Error("gone");
      const decoded = await readHandle(handle, encoding);
      update(current.id, { ...fromFile(handle, decoded), id: current.id });
    } catch (caught) {
      fail(caught);
    }
  };

  const view = () => (current ? views.current.get(current.id) : undefined);

  useShortcuts({
    "mod+n": newTab,
    "mod+o": () => void openFiles(),
    "mod+s": () => current && void save(current),
    "mod+shift+s": () => current && void save(current, true),
    "mod+w": () => current && void closeTab(current),
    "mod+g": () => {
      const editor = view();
      if (editor) gotoLine(editor);
    },
  });

  if (!docs || !current) return <LoadingState />;

  const words = countWords(current.text);
  return (
    <div className="text-app">
      <Toolbar label={t("app.name")}>
        <ToolbarTitle>{t("app.name")}</ToolbarTitle>
        <IconButton
          label={t("actions.new")}
          icon={<FilePlus size={16} aria-hidden />}
          onClick={newTab}
        />
        <IconButton
          label={t("actions.open")}
          icon={<FolderOpen size={16} aria-hidden />}
          onClick={() => void openFiles()}
        />
        <IconButton
          label={t("actions.recent")}
          icon={<History size={16} aria-hidden />}
          onClick={() => setRecentOpen(true)}
        />
        <IconButton
          label={t("actions.save")}
          icon={<Save size={16} aria-hidden />}
          onClick={() => void save(current)}
        />
        <Button size="sm" variant="ghost" onClick={() => void save(current, true)}>
          {t("actions.saveAs")}
        </Button>
        <Spacer />
        <IconButton
          label={t("actions.find")}
          icon={<Search size={16} aria-hidden />}
          onClick={() => {
            const editor = view();
            if (editor) openSearchPanel(editor);
          }}
        />
      </Toolbar>
      <div className="text-tabs" role="tablist" aria-label={t("tabs.label")}>
        {docs.map((doc, index) => (
          <div key={doc.id} className="text-tab" data-active={doc.id === current.id || undefined}>
            <button
              type="button"
              role="tab"
              aria-selected={doc.id === current.id}
              className="text-tab-name"
              title={doc.name}
              onClick={() => setActive(doc.id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                const next =
                  docs[
                    (index + (event.key === "ArrowRight" ? 1 : -1) + docs.length) % docs.length
                  ]!;
                setActive(next.id);
              }}
            >
              {isDirty(doc) ? (
                <span className="text-dirty" aria-label={t("tabs.unsaved")}>
                  ●
                </span>
              ) : null}
              {doc.name}
            </button>
            <IconButton
              size="sm"
              label={t("tabs.close", { name: doc.name })}
              icon={<X size={13} aria-hidden />}
              onClick={() => void closeTab(doc)}
            />
          </div>
        ))}
      </div>
      <div className="text-editors">
        {docs.map((doc) => (
          <div
            key={`${doc.id}:${settings.lineNumbers}:${settings.wrap}`}
            className="text-editor"
            hidden={doc.id !== current.id}
          >
            <CodeEditor
              value={doc.text}
              label={t("editor.label", { name: doc.name })}
              setup={{ gutters: settings.lineNumbers, wrap: settings.wrap, tabIndents: true }}
              onChange={(text) => update(doc.id, { text })}
              onView={(editor) => {
                if (editor) views.current.set(doc.id, editor);
                else views.current.delete(doc.id);
              }}
              extensions={EditorView.updateListener.of((change) => {
                if (!change.selectionSet && !change.docChanged) return;
                const head = change.state.selection.main.head;
                const line = change.state.doc.lineAt(head);
                setCursor({
                  line: line.number,
                  column: head - line.from + 1,
                  selected: change.state.selection.ranges.reduce(
                    (sum, range) => sum + range.to - range.from,
                    0,
                  ),
                });
              })}
            />
          </div>
        ))}
      </div>
      <footer className="text-status" aria-label={t("status.label")}>
        <span>{t("status.position", { line: cursor.line, column: cursor.column })}</span>
        {cursor.selected ? <span>{t("status.selected", { count: cursor.selected })}</span> : null}
        <span>{t("status.words", { count: words })}</span>
        <Spacer />
        <button
          type="button"
          className="text-status-button"
          onClick={() => setEncodingDialog("reopen")}
          title={t("encoding.change")}
        >
          {current.encoding.toUpperCase()}
          {current.bom ? " BOM" : ""}
        </button>
        <Select<LineEnding>
          label={t("eol.label")}
          hideLabel
          value={current.eol}
          onChange={(eol) => update(current.id, { eol })}
          options={[
            { value: "lf", label: "LF" },
            { value: "crlf", label: "CRLF" },
            { value: "cr", label: "CR" },
          ]}
        />
        <button
          type="button"
          className="text-status-button"
          aria-pressed={settings.wrap}
          onClick={() => setSettings((value) => ({ ...value, wrap: !value.wrap }))}
        >
          {t("status.wrap")}
        </button>
        <button
          type="button"
          className="text-status-button"
          aria-pressed={settings.lineNumbers}
          onClick={() => setSettings((value) => ({ ...value, lineNumbers: !value.lineNumbers }))}
        >
          {t("status.lineNumbers")}
        </button>
      </footer>
      <Dialog
        open={encodingDialog !== null}
        title={encodingDialog === "save" ? t("encoding.saveTitle") : t("encoding.title")}
        onClose={() => setEncodingDialog(null)}
        actions={<Button onClick={() => setEncodingDialog(null)}>{t("ui.cancel")}</Button>}
      >
        <p className="eui-hint">
          {encodingDialog === "save" ? t("encoding.saveHint") : t("encoding.hint")}
        </p>
        <ul className="eui-list text-encodings">
          {ENCODINGS.filter((encoding) => encodingDialog !== "save" || canWrite(encoding)).map(
            (encoding) => (
              <li key={encoding}>
                <ListItem
                  title={encoding.toUpperCase()}
                  meta={t(`encoding.names.${encoding}`)}
                  selected={encoding === current.encoding}
                  onClick={() => {
                    if (encodingDialog === "save") {
                      setEncodingDialog(null);
                      update(current.id, { encoding, bom: false });
                      void save({ ...current, encoding, bom: false });
                    } else void reopenWith(encoding);
                  }}
                />
              </li>
            ),
          )}
        </ul>
        {encodingDialog === "reopen" ? (
          <Button onClick={() => setEncodingDialog("save")}>{t("encoding.saveWith")}</Button>
        ) : null}
      </Dialog>
      <RecentDialog
        open={recentOpen}
        onClose={() => setRecentOpen(false)}
        onOpen={(handle) => void openRecent(handle)}
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
        <ul className="eui-list text-encodings">
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
