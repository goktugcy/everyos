import { gotoLine, openSearchPanel } from "@codemirror/search";
import type { FileHandle } from "@everyos/app-sdk";
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  errorMessage,
  IconButton,
  LoadingState,
  Select,
  Spacer,
  Toolbar,
  ToolbarTitle,
  shortcutLabel,
  useApp,
  useNarrow,
  usePersistentState,
  useShortcuts,
  useT,
  useToast,
} from "@everyos/app-ui";
import { EDITOR_LANGUAGES, languageNameFor, type EditorView } from "@everyos/app-ui/editor";
import {
  Code2,
  FilePlus,
  FileUp,
  FolderOpen,
  PanelLeft,
  Replace,
  Save,
  Settings2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DocEditor,
  DEFAULT_SETTINGS,
  FONT_SIZES,
  sanitizeSettings,
  TAB_SIZES,
  THEMES,
  type Cursor,
  type Settings,
  type ThemeName,
} from "./doc-editor.tsx";
import {
  BinaryFileError,
  decodeFile,
  EncodingError,
  fromFile,
  isDirty,
  MAX_FILE_BYTES,
  newDoc,
  Recovery,
  sameSource,
  toDisk,
  type Doc,
  type Eol,
  type Source,
} from "./documents.ts";
import { Explorer } from "./explorer.tsx";
import { Workspace, type Entry } from "./workspace.ts";

export function CodeApp() {
  const app = useApp();
  const t = useT();
  const toast = useToast();
  const narrow = useNarrow(760);
  const recovery = useMemo(() => new Recovery(app), [app]);
  const [storedSettings, setStoredSettings] = usePersistentState<Settings>(
    "settings",
    DEFAULT_SETTINGS,
  );
  const settings = sanitizeSettings(storedSettings);
  const [expanded, setExpanded] = usePersistentState<string[]>("expanded", []);
  const [sidebar, setSidebar] = usePersistentState("sidebar", true);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Cursor>({ line: 1, column: 1, selected: 0 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const views = useRef(new Map<string, EditorView>());
  const docsRef = useRef<Doc[]>([]);
  docsRef.current = docs ?? [];
  const canWrite = app.permissions.has("files:save");

  const fail = useCallback(
    (caught: unknown) => {
      const message = errorMessage(t, caught);
      if (message) toast(message, "danger");
    },
    [t, toast],
  );

  const readHandle = useCallback(
    async (handle: FileHandle) => {
      if (handle.size !== null && handle.size > MAX_FILE_BYTES)
        throw new RangeError(`too-large:${MAX_FILE_BYTES}`);
      return decodeFile(new Uint8Array(await app.files.read(handle)));
    },
    [app],
  );

  const handleFor = useCallback(
    async (source: Source): Promise<FileHandle | null> => {
      const handles = await app.files.handles();
      if (source.kind === "file")
        return handles.find((entry) => entry.id === source.handleId) ?? null;
      const root = handles.find(
        (entry) => entry.id === source.rootId && entry.kind === "directory",
      );
      return root ? app.files.child(root, source.path) : null;
    },
    [app],
  );

  // The last workspace folder and tabs.
  useEffect(() => {
    let stale = false;
    void (async () => {
      let space: Workspace | null = null;
      try {
        const rootId = await app.storage.get("workspace");
        const root =
          typeof rootId === "string"
            ? (await app.files.handles()).find(
                (entry) => entry.id === rootId && entry.kind === "directory",
              )
            : undefined;
        if (root) space = new Workspace(app, root);
      } catch {
        space = null;
      }
      const restored = await recovery
        .restore(async (source) => {
          const handle = await handleFor(source);
          return handle ? readHandle(handle) : null;
        })
        .catch(() => ({ docs: [], active: null, lost: [] as string[] }));
      if (stale) return;
      setWorkspace(space);
      setDocs(restored.docs);
      setActive(restored.active);
      if (restored.lost.length)
        toast(t("recovery.lost", { names: restored.lost.join(", ") }), "danger");
    })();
    return () => {
      stale = true;
    };
    // Once, at start.
  }, []);

  const current = docs?.find((doc) => doc.id === active) ?? docs?.[0] ?? null;

  // Recovery copies follow the tabs (debounced), and are written at once when the window goes
  // to the background or closes.
  const activeRef = useRef<string | null>(null);
  activeRef.current = current?.id ?? null;
  const persist = useCallback(() => {
    const list = docsRef.current;
    void recovery.saveIndex(list, activeRef.current).catch(() => undefined);
    for (const doc of list) void recovery.saveDoc(doc).catch(() => undefined);
  }, [recovery]);
  useEffect(() => {
    if (!docs) return;
    const timer = setTimeout(persist, 500);
    return () => clearTimeout(timer);
  }, [docs, current?.id, persist]);
  useEffect(() => {
    if (!docs) return;
    const stop = app.lifecycle.onSuspend(persist);
    window.addEventListener("pagehide", persist);
    return () => {
      stop();
      window.removeEventListener("pagehide", persist);
    };
  }, [app, docs !== null, persist]);

  // Closing the window with unsaved files asks first (recovery copies are kept either way).
  const dirtyCount = (docs ?? []).filter(isDirty).length;
  useEffect(() => {
    void app.lifecycle.guardClose(
      dirtyCount
        ? () =>
            app.dialogs.confirm(t("close.title", { count: dirtyCount }), t("close.body"), {
              confirm: t("close.confirm"),
              destructive: true,
            })
        : null,
    );
  }, [app, dirtyCount, t]);

  useEffect(() => {
    const name = current ? `${isDirty(current) ? "• " : ""}${current.name}` : t("app.name");
    void app.window.setTitle(workspace ? `${name} — ${workspace.name}` : name);
  }, [app, current, workspace, t]);

  // Access EveryOS withdrew: the folder closes, its tabs keep their text as unsaved copies.
  useEffect(
    () =>
      app.files.onRevoked((ids) => {
        if (workspace && ids.includes(workspace.root.id)) setWorkspace(null);
        const gone = (source: Source | null) =>
          !!source && ids.includes(source.kind === "file" ? source.handleId : source.rootId);
        setDocs(
          (list) =>
            list?.map((doc) =>
              gone(doc.source) ? { ...doc, source: null, savedText: "" } : doc,
            ) ?? list,
        );
      }),
    [app, workspace],
  );

  const update = (id: string, patch: Partial<Doc>) =>
    setDocs((list) => list?.map((doc) => (doc.id === id ? { ...doc, ...patch } : doc)) ?? list);

  const addDoc = (doc: Doc) => {
    setDocs((list) => [...(list ?? []), doc]);
    setActive(doc.id);
  };

  const newFile = () => {
    const untitled = docsRef.current.filter((doc) => !doc.source).length;
    addDoc(newDoc(t("doc.untitled", { number: untitled + 1 })));
  };

  const openSource = async (source: Source, handle: FileHandle) => {
    const already = docsRef.current.find((doc) => sameSource(doc.source, source));
    if (already) {
      setActive(already.id);
      return;
    }
    try {
      addDoc(fromFile(handle.name, source, await readHandle(handle)));
    } catch (caught) {
      if (caught instanceof BinaryFileError)
        toast(t("open.binary", { name: handle.name }), "danger");
      else if (caught instanceof EncodingError)
        toast(t("open.notUtf8", { name: handle.name }), "danger");
      else fail(caught);
    }
  };

  const openFiles = async () => {
    try {
      const handles = await app.files.open({ multiple: true, persist: true, write: canWrite });
      for (const handle of handles) await openSource({ kind: "file", handleId: handle.id }, handle);
    } catch (caught) {
      fail(caught);
    }
  };

  const openEntry = async (entry: Entry) => {
    if (!workspace) return;
    if (narrow) setSidebar(false);
    try {
      const source: Source = { kind: "workspace", rootId: workspace.root.id, path: entry.path };
      const already = docsRef.current.find((doc) => sameSource(doc.source, source));
      if (already) return setActive(already.id);
      await openSource(source, await workspace.file(entry.path));
    } catch (caught) {
      fail(caught);
    }
  };

  const openFolder = async () => {
    try {
      const [root] = await app.files.open({ directory: true, persist: true, write: canWrite });
      if (!root) return;
      setWorkspace(new Workspace(app, root));
      setExpanded([]);
      setSidebar(true);
      await app.storage.set("workspace", root.id);
    } catch (caught) {
      fail(caught);
    }
  };

  const closeFolder = () => {
    setWorkspace(null);
    setExpanded([]);
    void app.storage.delete("workspace").catch(() => undefined);
  };

  /** Writes a tab to its file (or asks where); false when it was not saved. */
  const save = async (doc: Doc, saveAs = false): Promise<boolean> => {
    try {
      let handle = !saveAs && doc.source ? await handleFor(doc.source).catch(() => null) : null;
      let source = doc.source;
      if (handle && !handle.writable) handle = null;
      if (handle) {
        // Someone else changed the file since it was opened or saved here: ask first.
        const onDisk = await readHandle(handle).catch(() => null);
        if (
          onDisk &&
          onDisk.text !== doc.savedText &&
          !(await app.dialogs.confirm(
            t("save.changedTitle", { name: doc.name }),
            t("save.changedBody"),
            { confirm: t("save.overwrite"), destructive: true },
          ))
        )
          return false;
      } else {
        handle = await app.files.save({ suggestedName: doc.name, persist: true });
        if (!handle) return false;
        source = { kind: "file", handleId: handle.id };
      }
      await app.files.write(handle, toDisk(doc));
      update(doc.id, { source, name: handle.name, savedText: doc.text, savedEol: doc.eol });
      toast(t("save.saved", { name: handle.name }));
      return true;
    } catch (caught) {
      fail(caught);
      return false;
    }
  };

  const closeTab = async (doc: Doc) => {
    if (
      isDirty(doc) &&
      !(await app.dialogs.confirm(t("close.tabTitle", { name: doc.name }), t("close.tabBody"), {
        confirm: t("close.discard"),
        destructive: true,
      }))
    )
      return;
    views.current.delete(doc.id);
    void recovery.forget(doc.id).catch(() => undefined);
    setDocs((list) => {
      const next = (list ?? []).filter((entry) => entry.id !== doc.id);
      if (activeRef.current === doc.id) setActive(next.at(-1)?.id ?? null);
      return next;
    });
  };

  const view = () => (current ? views.current.get(current.id) : undefined);
  const withView = (run: (editor: EditorView) => void) => {
    const editor = view();
    if (editor) run(editor);
  };

  useShortcuts({
    "mod+n": newFile,
    "mod+o": () => void openFiles(),
    "mod+s": () => current && void save(current),
    "mod+shift+s": () => current && void save(current, true),
    "mod+b": () => setSidebar((open) => !open),
    "mod+g": () => withView(gotoLine),
  });

  if (!docs) return <LoadingState />;

  const showExplorer = !!workspace && sidebar;
  // Everything but the colors needs new editors; colors are CSS variables.
  const editorKey = `${settings.fontSize}:${settings.tabSize}:${settings.insertSpaces}:${settings.wrap}:${settings.minimap}`;
  const detected = current ? languageNameFor(current.name) : null;
  const sourcePath = (doc: Doc) => (doc.source?.kind === "workspace" ? doc.source.path : doc.name);

  return (
    <div className="code-app" data-narrow={narrow || undefined}>
      <Toolbar label={t("app.name")}>
        {workspace ? (
          <IconButton
            label={`${showExplorer ? t("explorer.hide") : t("explorer.show")} (${shortcutLabel("mod+b")})`}
            icon={<PanelLeft size={16} aria-hidden />}
            aria-pressed={showExplorer}
            onClick={() => setSidebar((open) => !open)}
          />
        ) : null}
        <ToolbarTitle>{t("app.name")}</ToolbarTitle>
        <IconButton
          label={`${t("actions.new")} (${shortcutLabel("mod+n")})`}
          icon={<FilePlus size={16} aria-hidden />}
          onClick={newFile}
        />
        <IconButton
          label={`${t("actions.openFile")} (${shortcutLabel("mod+o")})`}
          icon={<FileUp size={16} aria-hidden />}
          onClick={() => void openFiles()}
        />
        <IconButton
          label={t("actions.openFolder")}
          icon={<FolderOpen size={16} aria-hidden />}
          onClick={() => void openFolder()}
        />
        <IconButton
          label={`${t("actions.save")} (${shortcutLabel("mod+s")})`}
          icon={<Save size={16} aria-hidden />}
          disabled={!current}
          onClick={() => current && void save(current)}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!current}
          onClick={() => current && void save(current, true)}
        >
          {t("actions.saveAs")}
        </Button>
        <Spacer />
        <IconButton
          label={`${t("actions.find")} (${shortcutLabel("mod+f")})`}
          icon={<Replace size={16} aria-hidden />}
          disabled={!current}
          onClick={() => withView(openSearchPanel)}
        />
        <IconButton
          label={t("settings.title")}
          icon={<Settings2 size={16} aria-hidden />}
          onClick={() => setSettingsOpen(true)}
        />
      </Toolbar>
      <div className="code-body" data-explorer={showExplorer || undefined}>
        {showExplorer && workspace ? (
          <Explorer
            workspace={workspace}
            activePath={current?.source?.kind === "workspace" ? current.source.path : null}
            expanded={expanded}
            onExpanded={setExpanded}
            onOpenFile={(entry) => void openEntry(entry)}
            onClose={closeFolder}
          />
        ) : null}
        <main className="code-main">
          {current ? (
            <>
              <div className="code-tabs" role="tablist" aria-label={t("tabs.label")}>
                {docs.map((doc, index) => (
                  <div
                    key={doc.id}
                    className="code-tab"
                    data-active={doc.id === current.id || undefined}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={doc.id === current.id}
                      className="code-tab-name"
                      title={sourcePath(doc)}
                      onClick={() => setActive(doc.id)}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                        const next =
                          docs[
                            (index + (event.key === "ArrowRight" ? 1 : -1) + docs.length) %
                              docs.length
                          ]!;
                        setActive(next.id);
                      }}
                    >
                      {isDirty(doc) ? (
                        <span className="code-dirty" aria-label={t("tabs.unsaved")}>
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
              <div className="code-editors" data-theme={settings.theme}>
                {docs.map((doc) => (
                  <DocEditor
                    key={`${doc.id}:${editorKey}`}
                    doc={doc}
                    settings={settings}
                    hidden={doc.id !== current.id}
                    onChange={(text) => update(doc.id, { text })}
                    onView={(editor) => {
                      if (editor) views.current.set(doc.id, editor);
                      else views.current.delete(doc.id);
                    }}
                    onCursor={setCursor}
                  />
                ))}
              </div>
              <footer className="code-status" aria-label={t("status.label")}>
                <span>{t("status.position", { line: cursor.line, column: cursor.column })}</span>
                {cursor.selected ? (
                  <span>{t("status.selected", { count: cursor.selected })}</span>
                ) : null}
                <Spacer />
                <Select
                  label={t("status.language")}
                  hideLabel
                  value={current.language ?? "auto"}
                  onChange={(value) =>
                    update(current.id, { language: value === "auto" ? null : value })
                  }
                  options={[
                    {
                      value: "auto",
                      label: detected
                        ? t("status.autoNamed", { name: detected })
                        : t("status.autoPlain"),
                    },
                    { value: "plain", label: t("status.plain") },
                    ...EDITOR_LANGUAGES.map((entry) => ({ value: entry.name, label: entry.name })),
                  ]}
                />
                <button
                  type="button"
                  className="code-status-button"
                  title={t("settings.title")}
                  onClick={() => setSettingsOpen(true)}
                >
                  {settings.insertSpaces
                    ? t("status.spaces", { count: settings.tabSize })
                    : t("status.tabs", { count: settings.tabSize })}
                </button>
                <Select<Eol>
                  label={t("status.eol")}
                  hideLabel
                  value={current.eol}
                  onChange={(eol) => update(current.id, { eol })}
                  options={[
                    { value: "lf", label: "LF" },
                    { value: "crlf", label: "CRLF" },
                  ]}
                />
                <span>{current.bom ? "UTF-8 BOM" : "UTF-8"}</span>
              </footer>
            </>
          ) : (
            <EmptyState
              icon={<Code2 size={32} aria-hidden />}
              title={t("welcome.title")}
              text={workspace ? t("welcome.withFolder") : t("welcome.text")}
              action={
                <div className="code-welcome">
                  <Button
                    variant="primary"
                    icon={<FolderOpen size={15} aria-hidden />}
                    onClick={() => void openFolder()}
                  >
                    {t("actions.openFolder")}
                  </Button>
                  <Button icon={<FileUp size={15} aria-hidden />} onClick={() => void openFiles()}>
                    {t("actions.openFile")}
                  </Button>
                  <Button icon={<FilePlus size={15} aria-hidden />} onClick={newFile}>
                    {t("actions.new")}
                  </Button>
                </div>
              }
            />
          )}
        </main>
      </div>
      <Dialog
        open={settingsOpen}
        title={t("settings.title")}
        onClose={() => setSettingsOpen(false)}
        actions={<Button onClick={() => setSettingsOpen(false)}>{t("ui.close")}</Button>}
      >
        <div className="code-settings">
          <Select<ThemeName>
            label={t("settings.theme")}
            value={settings.theme}
            onChange={(theme) => setStoredSettings({ ...settings, theme })}
            options={THEMES.map((theme) => ({
              value: theme,
              label: t(`settings.themes.${theme}`),
            }))}
          />
          <Select
            label={t("settings.fontSize")}
            value={String(settings.fontSize)}
            onChange={(value) => setStoredSettings({ ...settings, fontSize: Number(value) })}
            options={FONT_SIZES.map((size) => ({ value: String(size), label: `${size} px` }))}
          />
          <Select
            label={t("settings.tabSize")}
            value={String(settings.tabSize)}
            onChange={(value) => setStoredSettings({ ...settings, tabSize: Number(value) })}
            options={TAB_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
          />
          <Checkbox
            label={t("settings.insertSpaces")}
            checked={settings.insertSpaces}
            onChange={(insertSpaces) => setStoredSettings({ ...settings, insertSpaces })}
          />
          <Checkbox
            label={t("settings.wrap")}
            checked={settings.wrap}
            onChange={(wrap) => setStoredSettings({ ...settings, wrap })}
          />
          <Checkbox
            label={t("settings.minimap")}
            checked={settings.minimap}
            onChange={(minimap) => setStoredSettings({ ...settings, minimap })}
          />
        </div>
      </Dialog>
    </div>
  );
}
