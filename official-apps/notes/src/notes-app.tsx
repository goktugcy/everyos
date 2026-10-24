import {
  Button,
  Dialog,
  EmptyState,
  errorMessage,
  ErrorState,
  exportJson,
  IconButton,
  LoadingState,
  openFiles,
  SearchInput,
  Select,
  Shell,
  Spacer,
  TextField,
  Toolbar,
  ToolbarTitle,
  useApp,
  useDebounced,
  useI18n,
  useNarrow,
  usePersistentState,
  useShortcuts,
  useT,
  useToast,
  VirtualList,
} from "@everyos/app-ui";
import {
  FileUp,
  FolderPlus,
  NotebookPen,
  Pencil,
  Pin,
  SquarePen,
  Trash2,
  Download,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDraft } from "./draft.ts";
import { Editor, type Mode } from "./editor.tsx";
import { HistoryDialog } from "./history-dialog.tsx";
import { Sidebar, type View } from "./sidebar.tsx";
import { NotesStore, type NoteMeta } from "./store.ts";

type Sort = "updated" | "created" | "title";
interface Settings {
  sort: Sort;
  mode: Mode;
}

const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** What a widget or a reload asks the window to show. */
function requestedNote(state: unknown): string | null {
  const id = (state as { noteId?: unknown } | null)?.noteId;
  return typeof id === "string" ? id : null;
}

export function NotesApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const narrow = useNarrow(760);
  const store = useMemo(() => new NotesStore(app), [app]);
  const [settings, setSettings] = usePersistentState<Settings>("settings", {
    sort: "updated",
    mode: "split",
  });
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [view, setView] = useState<View>({ kind: "all" });
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim().toLowerCase(), 150);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    requestedNote(app.window.initialState),
  );
  const [showEditor, setShowEditor] = useState(selectedId !== null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [folderDialog, setFolderDialog] = useState<{ rename: string | null } | null>(null);
  const bodies = useRef(new Map<string, { at: number; text: string }>());
  const [bodiesLoaded, setBodiesLoaded] = useState(0);
  const searchRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const fail = useCallback((error: unknown) => toast(errorMessage(t, error), "danger"), [t, toast]);

  const refresh = useCallback(async () => {
    try {
      const [list, names] = await Promise.all([store.list(), store.folders()]);
      setNotes(list);
      setFolders(names);
      setLoadError(null);
    } catch (error) {
      setLoadError(error);
    }
  }, [store]);

  const onSaved = useCallback((meta: NoteMeta, text: string) => {
    bodies.current.set(meta.id, { at: meta.updatedAt, text });
    setNotes((list) => list?.map((note) => (note.id === meta.id ? meta : note)) ?? list);
  }, []);
  const draft = useDraft(store, selectedId, onSaved, fail);

  // The list follows changes made elsewhere (the quick-note widget) when the window comes back.
  useEffect(() => {
    void refresh();
    const stopResume = app.lifecycle.onResume(() => void refresh());
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      stopResume();
      window.removeEventListener("focus", onFocus);
    };
  }, [app, refresh]);

  useEffect(
    () =>
      app.window.onOpened((state) => {
        const id = requestedNote(state);
        if (!id) return;
        setView({ kind: "all" });
        setQuery("");
        setSelectedId(id);
        setShowEditor(true);
        void refresh();
      }),
    [app, refresh],
  );

  const selected = notes?.find((note) => note.id === selectedId) ?? null;

  // The window remembers the open note across reloads, and is titled after it.
  useEffect(() => {
    void app.window.saveState(selectedId ? { noteId: selectedId } : null);
  }, [app, selectedId]);
  const title = selected ? selected.title || t("list.untitled") : t("app.name");
  useEffect(() => {
    void app.window.setTitle(title);
  }, [app, title]);

  // Searching reads the notes' text once (then keeps it in step with saves).
  useEffect(() => {
    if (!search || !notes) return;
    const missing = notes.filter((note) => bodies.current.get(note.id)?.at !== note.updatedAt);
    if (!missing.length) return;
    let stale = false;
    void Promise.all(missing.map(async (note) => [note, await store.read(note.id)] as const)).then(
      (entries) => {
        for (const [note, text] of entries)
          bodies.current.set(note.id, { at: note.updatedAt, text });
        if (!stale) setBodiesLoaded((count) => count + 1);
      },
      fail,
    );
    return () => {
      stale = true;
    };
  }, [search, notes, store, fail]);

  const visible = useMemo(() => {
    if (!notes) return [];
    const inTrash = view.kind === "trash";
    let list = notes.filter((note) => (note.deletedAt !== null) === inTrash);
    if (view.kind === "pinned") list = list.filter((note) => note.pinned);
    if (view.kind === "folder") list = list.filter((note) => note.folder === view.name);
    if (view.kind === "tag") list = list.filter((note) => note.tags.includes(view.name));
    if (search) {
      const tag = search.replace(/^#/, "");
      list = list.filter(
        (note) =>
          note.title.toLowerCase().includes(search) ||
          note.tags.some((name) => name.includes(tag)) ||
          (bodies.current.get(note.id)?.text ?? note.excerpt).toLowerCase().includes(search),
      );
    }
    const collator = new Intl.Collator(i18n.tag, { sensitivity: "base", numeric: true });
    const order = (a: NoteMeta, b: NoteMeta) =>
      settings.sort === "title"
        ? collator.compare(a.title || "￿", b.title || "￿")
        : settings.sort === "created"
          ? b.createdAt - a.createdAt
          : b.updatedAt - a.updatedAt;
    return list.sort(
      (a, b) =>
        (inTrash ? (b.deletedAt ?? 0) - (a.deletedAt ?? 0) : Number(b.pinned) - Number(a.pinned)) ||
        order(a, b),
    );
    // bodiesLoaded: the text of the notes arrived for searching.
  }, [notes, view, search, settings.sort, i18n.tag, bodiesLoaded]);

  const select = (id: string | null) => {
    setSelectedId(id);
    setShowEditor(id !== null);
  };

  const run = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      fail(error);
    }
    await refresh();
  };

  const newNote = () =>
    run(async () => {
      await draft.flush();
      const note = await store.create({
        folder: view.kind === "folder" ? view.name : null,
        tags: view.kind === "tag" ? [view.name] : [],
        pinned: view.kind === "pinned",
      });
      if (view.kind === "trash") setView({ kind: "all" });
      setQuery("");
      if (settings.mode === "preview") setSettings((current) => ({ ...current, mode: "split" }));
      select(note.id);
      setTimeout(() => editorRef.current?.focus(), 50);
    });

  const remove = (note: NoteMeta) =>
    run(async () => {
      await draft.flush();
      const index = visible.findIndex((entry) => entry.id === note.id);
      await store.remove(note.id);
      toast(t("trash.moved"));
      const next = visible[index + 1] ?? visible[index - 1] ?? null;
      select(next && next.id !== note.id ? next.id : null);
    });

  const destroy = async (note: NoteMeta) => {
    const name = note.title || t("list.untitled");
    if (
      !(await app.dialogs.confirm(t("trash.deleteTitle", { name }), t("trash.body"), {
        confirm: t("actions.deleteForever"),
        destructive: true,
      }))
    )
      return;
    await run(async () => {
      await store.destroy(note.id);
      if (selectedId === note.id) select(null);
    });
  };

  const emptyTrash = async () => {
    const trash = notes?.filter((note) => note.deletedAt !== null) ?? [];
    if (!trash.length) return;
    if (
      !(await app.dialogs.confirm(t("trash.emptyTitle"), t("trash.body"), {
        confirm: t("actions.emptyTrash"),
        destructive: true,
      }))
    )
      return;
    await run(async () => {
      for (const note of trash) await store.destroy(note.id);
      select(null);
    });
  };

  const importNotes = () =>
    run(async () => {
      const handles = await openFiles(app, { accept: [".md", ".markdown", ".txt", ".json"] });
      if (!handles.length) return;
      let added = 0;
      for (const handle of handles) {
        if (handle.size !== null && handle.size > IMPORT_MAX_BYTES) {
          toast(t("import.skipped", { name: handle.name }), "danger");
          continue;
        }
        const text = await app.files.readText(handle);
        if (/\.json$/i.test(handle.name)) added += await store.importBackup(JSON.parse(text));
        else
          added += await store.importFiles(
            [{ name: handle.name, text }],
            view.kind === "folder" ? view.name : null,
          );
      }
      toast(added ? t("import.done", { count: added }) : t("import.none"));
    });

  const exportAll = () =>
    run(async () => {
      await draft.flush();
      const day = new Date().toISOString().slice(0, 10);
      if (await exportJson(app, `notes-${day}.json`, await store.exportAll()))
        toast(t("ui.exported"));
    });

  const deleteFolder = async (name: string) => {
    if (
      !(await app.dialogs.confirm(t("folder.deleteTitle", { name }), t("folder.deleteBody"), {
        confirm: t("ui.delete"),
        destructive: true,
      }))
    )
      return;
    await run(async () => {
      await store.deleteFolder(name);
      setView({ kind: "all" });
    });
  };

  const cycleMode = () =>
    setSettings((current) => ({
      ...current,
      mode: current.mode === "edit" ? "split" : current.mode === "split" ? "preview" : "edit",
    }));

  useShortcuts({
    "mod+n": () => void newNote(),
    "mod+f": () => searchRef.current?.querySelector("input")?.focus(),
    "mod+e": cycleMode,
    "mod+s": () => void draft.flush(),
    "mod+shift+p": () => {
      if (selected && selected.deletedAt === null)
        void run(() => store.update(selected.id, { pinned: !selected.pinned }));
    },
  });

  if (loadError && !notes) return <ErrorState error={loadError} onRetry={() => void refresh()} />;
  if (!notes) return <LoadingState />;

  const counts = {
    all: notes.filter((note) => note.deletedAt === null).length,
    pinned: notes.filter((note) => note.deletedAt === null && note.pinned).length,
    trash: notes.filter((note) => note.deletedAt !== null).length,
  };
  const listPane = (
    <section className="notes-list" aria-label={t("list.label")}>
      <div className="notes-list-head" ref={searchRef}>
        <SearchInput value={query} onChange={setQuery} label={t("list.search")} />
        <div className="notes-list-tools">
          <Select<Sort>
            label={t("list.sort")}
            hideLabel
            value={settings.sort}
            options={[
              { value: "updated", label: t("list.sortUpdated") },
              { value: "created", label: t("list.sortCreated") },
              { value: "title", label: t("list.sortTitle") },
            ]}
            onChange={(sort) => setSettings((current) => ({ ...current, sort }))}
          />
          {view.kind === "folder" ? (
            <>
              <IconButton
                label={t("actions.renameFolder")}
                icon={<Pencil size={15} aria-hidden />}
                onClick={() => setFolderDialog({ rename: view.name })}
              />
              <IconButton
                label={t("actions.deleteFolder")}
                icon={<Trash2 size={15} aria-hidden />}
                onClick={() => void deleteFolder(view.name)}
              />
            </>
          ) : null}
          {view.kind === "trash" && counts.trash ? (
            <Button size="sm" variant="danger" onClick={() => void emptyTrash()}>
              {t("actions.emptyTrash")}
            </Button>
          ) : null}
        </div>
      </div>
      {visible.length ? (
        <VirtualList
          items={visible}
          rowHeight={68}
          label={t("list.label")}
          getKey={(note) => note.id}
          activeIndex={Math.max(
            0,
            visible.findIndex((note) => note.id === selectedId),
          )}
          onActivate={(index) => select(visible[index]?.id ?? null)}
          onChoose={(note) => {
            select(note.id);
            editorRef.current?.focus();
          }}
          render={(note) => (
            <div
              className="notes-row"
              data-selected={note.id === selectedId || undefined}
              onClick={() => select(note.id)}
            >
              <span className="notes-row-title">
                {note.pinned ? <Pin size={12} aria-label={t("list.pinned")} /> : null}
                {note.title || t("list.untitled")}
              </span>
              <span className="notes-row-meta">
                <time dateTime={new Date(note.updatedAt).toISOString()}>
                  {i18n.date(note.updatedAt, { dateStyle: "medium" })}
                </time>{" "}
                {note.excerpt || t("list.noText")}
              </span>
            </div>
          )}
        />
      ) : search ? (
        <EmptyState title={t("empty.search", { query })} />
      ) : view.kind === "trash" ? (
        <EmptyState
          icon={<Trash2 size={30} aria-hidden />}
          title={t("empty.trash")}
          text={t("empty.trashText")}
        />
      ) : (
        <EmptyState
          icon={<NotebookPen size={30} aria-hidden />}
          title={t("empty.title")}
          text={t("empty.text")}
          action={
            <Button variant="primary" onClick={() => void newNote()}>
              {t("actions.newNote")}
            </Button>
          }
        />
      )}
    </section>
  );

  const editorPane = selected ? (
    <Editor
      key={selected.id}
      note={selected}
      folders={folders}
      draft={draft}
      mode={settings.mode}
      editorRef={editorRef}
      onBack={narrow ? () => setShowEditor(false) : null}
      onMode={(mode) => setSettings((current) => ({ ...current, mode }))}
      onUpdate={(patch) => run(() => store.update(selected.id, patch))}
      onDelete={() => void remove(selected)}
      onRestore={() =>
        run(async () => {
          await store.restore(selected.id);
          toast(t("trash.restored"));
        })
      }
      onDestroy={() => void destroy(selected)}
      onHistory={() => setHistoryOpen(true)}
      onFailed={fail}
    />
  ) : (
    <EmptyState icon={<NotebookPen size={30} aria-hidden />} title={t("empty.select")} />
  );

  return (
    <>
      <Shell
        sidebarWidth={220}
        toolbar={(sidebarButton) => (
          <Toolbar label={t("app.name")}>
            {sidebarButton}
            <ToolbarTitle>{t("app.name")}</ToolbarTitle>
            <Spacer />
            <IconButton
              label={t("actions.import")}
              icon={<FileUp size={16} aria-hidden />}
              onClick={() => void importNotes()}
            />
            <IconButton
              label={t("actions.exportAll")}
              icon={<Download size={16} aria-hidden />}
              onClick={() => void exportAll()}
            />
            <IconButton
              label={t("actions.newFolder")}
              icon={<FolderPlus size={16} aria-hidden />}
              onClick={() => setFolderDialog({ rename: null })}
            />
            <Button
              variant="primary"
              icon={<SquarePen size={15} aria-hidden />}
              onClick={() => void newNote()}
            >
              {t("actions.newNote")}
            </Button>
          </Toolbar>
        )}
        sidebar={
          <Sidebar
            view={view}
            notes={notes}
            folders={folders}
            counts={counts}
            onView={(next) => {
              setView(next);
              setShowEditor(false);
            }}
          />
        }
      >
        <div className="notes-body" data-narrow={narrow || undefined}>
          {!narrow || !showEditor ? listPane : null}
          {!narrow || showEditor ? <div className="notes-editor">{editorPane}</div> : null}
        </div>
      </Shell>
      {selected ? (
        <HistoryDialog
          open={historyOpen}
          store={store}
          note={selected}
          onClose={() => setHistoryOpen(false)}
          onRestored={(text) => {
            setHistoryOpen(false);
            void draft.reload(text);
            toast(t("history.restored"));
            void refresh();
          }}
        />
      ) : null}
      <FolderDialog
        state={folderDialog}
        folders={folders}
        onClose={() => setFolderDialog(null)}
        onSubmit={(name) =>
          run(async () => {
            if (folderDialog?.rename) {
              await store.renameFolder(folderDialog.rename, name);
              setView({ kind: "folder", name });
            } else {
              await store.setFolders([...folders, name]);
              setView({ kind: "folder", name });
            }
            setFolderDialog(null);
          })
        }
      />
    </>
  );
}

function FolderDialog({
  state,
  folders,
  onClose,
  onSubmit,
}: {
  state: { rename: string | null } | null;
  folders: string[];
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  useEffect(() => setName(state?.rename ?? ""), [state]);
  const clean = name.trim();
  const taken = clean !== state?.rename && folders.includes(clean);
  const submit = () => {
    if (clean && !taken) onSubmit(clean);
  };
  return (
    <Dialog
      open={state !== null}
      title={state?.rename ? t("actions.renameFolder") : t("actions.newFolder")}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button variant="primary" disabled={!clean || taken} onClick={submit}>
            {state?.rename ? t("ui.rename") : t("ui.create")}
          </Button>
        </>
      }
    >
      <TextField
        label={t("folder.name")}
        value={name}
        maxLength={80}
        autoFocus
        error={taken ? t("folder.exists") : undefined}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />
    </Dialog>
  );
}
