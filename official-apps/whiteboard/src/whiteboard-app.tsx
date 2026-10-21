import type { ThemeSnapshot } from "@everyos/app-sdk";
import {
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  LoadingState,
  Spacer,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  saveTextFile,
  useApp,
  useI18n,
  useNarrow,
  usePersistentState,
  useT,
  useToast,
} from "@everyos/app-ui";
import { Copy, FileDown, FileImage, FileUp, PanelLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoardStore, BoardTooLargeError, pack, unpack, type Board } from "./boards.ts";
import type { CanvasController, CanvasModule } from "./canvas-types.ts";

/** Files a board can be imported from (EveryOS serves PNG and SVG with the scene inside). */
export const IMPORT_TYPES = [".excalidraw", ".json", ".png", ".svg"];
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
/** The shape library is kept while it fits in one storage value. */
const MAX_LIBRARY_CHARS = 240_000;
/** Pause after the last change before the board is written. */
export const SAVE_DELAY_MS = 800;

const defaultCanvas = () => import("./canvas.tsx").then((module) => module.canvasModule);

type Status = "saved" | "saving" | "tooLarge" | "failed";

export function WhiteboardApp({
  loadCanvas = defaultCanvas,
}: {
  loadCanvas?: () => Promise<CanvasModule>;
}) {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const narrow = useNarrow(720);
  const store = useMemo(() => new BoardStore(app), [app]);
  const [module, setModule] = useState<CanvasModule | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [currentId, setCurrentId, currentStatus] = usePersistentState<string | null>(
    "current",
    null,
  );
  const [sidebar, setSidebar] = usePersistentState("sidebar", true);
  const [opened, setOpened] = useState<{
    id: string;
    scene: string | null;
    library: string | null;
  } | null>(null);
  const [status, setStatus] = useState<Status>("saved");
  const [theme, setTheme] = useState<ThemeSnapshot>(app.theme.current);
  const controller = useRef<CanvasController | null>(null);
  const saved = useRef<{ id: string; version: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => app.theme.onChange(setTheme), [app]);

  const fail = useCallback(
    (caught: unknown) => {
      const message = errorMessage(t, caught);
      if (message) toast(message, "danger");
    },
    [t, toast],
  );

  // The drawing surface and the board list; the first visit gets a first board.
  useEffect(() => {
    void loadCanvas().then(setModule, setFailure);
    void (async () => {
      // A drawing stashed by a window that closed before it could be saved.
      await store.recover().catch(() => null);
      setBoards(await store.ensureOne(t("boards.first")));
    })().catch((caught: unknown) => {
      setFailure(caught);
      setBoards([]);
    });
  }, [store]);

  const boardId =
    boards && currentStatus.loaded
      ? (boards.find((board) => board.id === currentId)?.id ?? boards[0]?.id ?? null)
      : null;
  const board = boards?.find((entry) => entry.id === boardId) ?? null;

  /** Writes the open board now if its drawing changed since it was last written. */
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const canvas = controller.current;
    const open = saved.current;
    if (!canvas || !open) return;
    const version = canvas.version();
    if (version === open.version) return;
    setStatus("saving");
    try {
      const updated = await store.save(open.id, canvas.serialize());
      saved.current = { id: open.id, version };
      setBoards(
        (list) => list?.map((entry) => (entry.id === updated.id ? updated : entry)) ?? list,
      );
      setStatus("saved");
    } catch (caught) {
      setStatus(caught instanceof BoardTooLargeError ? "tooLarge" : "failed");
    }
  }, [store]);

  /**
   * The window is closing: no time to compress, so the drawing is stashed as it is (every request
   * leaves at once) and saved properly when the Whiteboard opens next.
   */
  const stashNow = useCallback(() => {
    clearTimeout(timer.current);
    const canvas = controller.current;
    const open = saved.current;
    if (!canvas || !open) return;
    const version = canvas.version();
    if (version !== open.version && store.stash(open.id, canvas.serialize()))
      saved.current = { id: open.id, version };
  }, [store]);

  useEffect(() => {
    const stop = app.lifecycle.onSuspend(() => void flush());
    const onHide = stashNow;
    window.addEventListener("pagehide", onHide);
    return () => {
      stop();
      window.removeEventListener("pagehide", onHide);
    };
  }, [app, flush, stashNow]);

  // Opening a board: its scene and the shape library, then a fresh canvas.
  useEffect(() => {
    if (!boardId) return;
    let live = true;
    controller.current = null;
    saved.current = null;
    setOpened(null);
    void Promise.all([store.load(boardId), loadLibrary()])
      .then(([scene, library]) => {
        if (!live) return;
        setOpened({ id: boardId, scene, library });
        setStatus("saved");
      })
      .catch((caught: unknown) => {
        if (live) setFailure(caught);
      });
    return () => {
      live = false;
    };
  }, [boardId, store]);

  const loadLibrary = async () => {
    const stored = await app.storage.get("library").catch(() => null);
    return typeof stored === "string" ? unpack(stored).catch(() => null) : null;
  };

  useEffect(() => {
    void app.window.setTitle(board ? `${board.name} — ${t("app.name")}` : t("app.name"));
  }, [app, board, t]);

  const switchTo = async (id: string) => {
    if (id === boardId) return;
    await flush();
    setCurrentId(id);
    if (narrow) setSidebar(false);
  };

  const create = async () => {
    try {
      await flush();
      const created = await store.create(
        t("boards.untitled", { number: (boards?.length ?? 0) + 1 }),
      );
      setBoards(await store.list());
      setCurrentId(created.id);
    } catch (caught) {
      fail(caught);
    }
  };

  const rename = async (target: Board) => {
    const name = await app.dialogs.prompt(t("boards.renameTitle"), undefined, {
      value: target.name,
    });
    if (!name?.trim()) return;
    try {
      await store.rename(target.id, name);
      setBoards(await store.list());
    } catch (caught) {
      fail(caught);
    }
  };

  const duplicate = async (target: Board) => {
    try {
      await flush();
      const copy = await store.duplicate(target.id, t("boards.copyName", { name: target.name }));
      setBoards(await store.list());
      setCurrentId(copy.id);
    } catch (caught) {
      fail(caught);
    }
  };

  const remove = async (target: Board) => {
    if (
      !(await app.dialogs.confirm(
        t("boards.deleteTitle", { name: target.name }),
        t("ui.deleteBody"),
        {
          confirm: t("ui.delete"),
          destructive: true,
        },
      ))
    )
      return;
    try {
      if (target.id === boardId) {
        clearTimeout(timer.current);
        saved.current = null;
      }
      await store.remove(target.id);
      const list = await store.ensureOne(t("boards.first"));
      setBoards(list);
      if (target.id === boardId) setCurrentId(list[0]!.id);
    } catch (caught) {
      fail(caught);
    }
  };

  const importBoard = async () => {
    if (!module) return;
    try {
      const [handle] = await app.files.open({ accept: IMPORT_TYPES });
      if (!handle) return;
      if (handle.size !== null && handle.size > MAX_IMPORT_BYTES)
        throw new RangeError(`too-large:${MAX_IMPORT_BYTES}`);
      let scene: string;
      try {
        scene = await module.importScene(new Uint8Array(await app.files.read(handle)), handle.name);
      } catch {
        toast(t("import.invalid", { name: handle.name }), "danger");
        return;
      }
      await flush();
      const created = await store.create(
        handle.name.replace(/\.[^.]*$/, "") || t("boards.imported"),
      );
      await store.save(created.id, scene);
      setBoards(await store.list());
      setCurrentId(created.id);
      toast(t("import.done", { name: handle.name }));
    } catch (caught) {
      if (caught instanceof BoardTooLargeError) toast(t("status.tooLarge"), "danger");
      else fail(caught);
    }
  };

  const exportAs = async (kind: "png" | "svg" | "excalidraw") => {
    const canvas = controller.current;
    if (!canvas || !board) return;
    if (kind !== "excalidraw" && canvas.isEmpty()) {
      toast(t("export.empty"), "danger");
      return;
    }
    try {
      const content =
        kind === "png"
          ? await canvas.exportPng()
          : kind === "svg"
            ? await canvas.exportSvg()
            : canvas.serialize();
      if (await saveTextFile(app, `${board.name}.${kind}`, content, { accept: [`.${kind}`] }))
        toast(t("export.done", { name: `${board.name}.${kind}` }));
    } catch (caught) {
      fail(caught);
    }
  };

  if (failure) return <ErrorState error={failure} title={t("errors.load")} />;
  if (!boards || !module) return <LoadingState />;

  const { Canvas } = module;
  const statusText =
    status === "saving"
      ? t("status.saving")
      : status === "tooLarge"
        ? t("status.tooLarge")
        : status === "failed"
          ? t("status.failed")
          : t("status.saved");

  return (
    <div className="wb-app" data-narrow={narrow || undefined}>
      <Toolbar label={t("app.name")}>
        <IconButton
          label={sidebar ? t("boards.hide") : t("boards.show")}
          icon={<PanelLeft size={16} aria-hidden />}
          aria-pressed={sidebar}
          onClick={() => setSidebar((open) => !open)}
        />
        <ToolbarTitle>{board?.name ?? t("app.name")}</ToolbarTitle>
        <span className="wb-status" role="status" data-status={status}>
          {statusText}
        </span>
        <Spacer />
        <IconButton
          label={t("import.action")}
          icon={<FileUp size={16} aria-hidden />}
          onClick={() => void importBoard()}
        />
        <Button
          size="sm"
          variant="ghost"
          icon={<FileImage size={15} aria-hidden />}
          onClick={() => void exportAs("png")}
        >
          PNG
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<FileImage size={15} aria-hidden />}
          onClick={() => void exportAs("svg")}
        >
          SVG
        </Button>
        <IconButton
          label={t("export.board")}
          icon={<FileDown size={16} aria-hidden />}
          onClick={() => void exportAs("excalidraw")}
        />
      </Toolbar>
      <div className="wb-body" data-sidebar={sidebar || undefined}>
        {sidebar ? (
          <aside className="wb-boards" aria-label={t("boards.label")}>
            <Button
              size="sm"
              variant="primary"
              icon={<Plus size={14} aria-hidden />}
              onClick={() => void create()}
            >
              {t("boards.new")}
            </Button>
            <ul>
              {boards.map((entry) => (
                <li key={entry.id} data-current={entry.id === boardId || undefined}>
                  <button
                    type="button"
                    className="wb-board"
                    aria-current={entry.id === boardId ? "page" : undefined}
                    onClick={() => void switchTo(entry.id)}
                  >
                    <span className="wb-board-name">{entry.name}</span>
                    <span className="wb-board-date">
                      {i18n.date(entry.updatedAt, { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                  </button>
                  <IconButton
                    size="sm"
                    label={t("boards.rename", { name: entry.name })}
                    icon={<Pencil size={13} aria-hidden />}
                    onClick={() => void rename(entry)}
                  />
                  <IconButton
                    size="sm"
                    label={t("boards.duplicate", { name: entry.name })}
                    icon={<Copy size={13} aria-hidden />}
                    onClick={() => void duplicate(entry)}
                  />
                  <IconButton
                    size="sm"
                    label={t("boards.delete", { name: entry.name })}
                    icon={<Trash2 size={13} aria-hidden />}
                    onClick={() => void remove(entry)}
                  />
                </li>
              ))}
            </ul>
          </aside>
        ) : null}
        <main className="wb-main">
          {opened && board ? (
            <Canvas
              key={opened.id}
              scene={opened.scene}
              library={opened.library}
              theme={theme.scheme === "dark" ? "dark" : "light"}
              locale={i18n.locale}
              name={board.name}
              labels={{
                canvas: t("canvas.label", { name: board.name }),
                welcome: t("canvas.welcome"),
              }}
              onReady={(ready) => {
                controller.current = ready;
                saved.current = { id: opened.id, version: ready.version() };
              }}
              onChange={() => {
                clearTimeout(timer.current);
                timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
              }}
              onLibrary={(json) => {
                void pack(json)
                  .then((packed) =>
                    packed.length <= MAX_LIBRARY_CHARS
                      ? app.storage.set("library", packed)
                      : toast(t("library.tooLarge"), "danger"),
                  )
                  .catch(() => undefined);
              }}
            />
          ) : board ? (
            <LoadingState />
          ) : (
            <EmptyState title={t("boards.none")} />
          )}
        </main>
      </div>
    </div>
  );
}
