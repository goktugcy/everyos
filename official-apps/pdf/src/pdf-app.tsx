import type { FileHandle } from "@everyos/app-sdk";
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  errorMessage,
  formatBytes,
  IconButton,
  ListItem,
  LoadingState,
  Select,
  Spacer,
  TextField,
  Toolbar,
  ToolbarTitle,
  saveTextFile,
  shortcutLabel,
  useApp,
  useI18n,
  useNarrow,
  usePersistentState,
  useShortcuts,
  useT,
  useToast,
} from "@everyos/app-ui";
import {
  Bookmark as BookmarkIcon,
  BookmarkCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  FileText,
  FolderOpen,
  PanelLeft,
  Printer,
  RotateCcw,
  RotateCw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  addRecent,
  docKey,
  isRecent,
  nextRotation,
  parsePage,
  removeBookmark,
  sanitizeDocState,
  setBookmark,
  ZOOM_LEVELS,
  ZOOM_PRESETS,
  type Bookmark,
  type DocState,
  type Recent,
} from "./library.ts";
import { preparePrint } from "./print.ts";
import { Sidebar, type SidebarTab } from "./sidebar.tsx";
import type { FindQuery, OutlineItem, PdfEngine, PdfSession, ZoomValue } from "./types.ts";

/** Larger files are refused: the whole document is held in memory. */
export const MAX_PDF_BYTES = 200 * 1024 * 1024;

const defaultEngine = () => import("./engine.ts").then((module) => module.engine);

interface OpenDoc {
  session: PdfSession;
  name: string;
  handleId: string;
}

interface FindStatus {
  state: "found" | "notFound" | "wrapped" | "pending";
  current: number;
  total: number;
}

class TooLargeError extends Error {}

export function PdfApp({ loadEngine = defaultEngine }: { loadEngine?: () => Promise<PdfEngine> }) {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const narrow = useNarrow(720);
  const [panel, setPanel] = usePersistentState<{ open: boolean; tab: SidebarTab }>("sidebar", {
    open: true,
    tab: "pages",
  });
  const [storedRecent, setRecent] = usePersistentState<Recent[]>("recent", []);
  const recent = Array.isArray(storedRecent) ? storedRecent.filter(isRecent) : [];
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoomChoice] = useState<ZoomValue>("auto");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState<FindQuery>({
    text: "",
    caseSensitive: false,
    entireWord: false,
  });
  const [findStatus, setFindStatus] = useState<FindStatus | null>(null);
  const [printing, setPrinting] = useState<{ done: number; total: number } | null>(null);
  const [password, setPassword] = useState<{
    reason: "need" | "incorrect";
    resolve: (value: string | null) => void;
  } | null>(null);
  const [passwordText, setPasswordText] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const printTarget = useRef<HTMLDivElement>(null);
  const printAbort = useRef<AbortController | null>(null);
  const stepping = useRef(false);
  const session = doc?.session ?? null;
  const sidebarOpen = !!doc && panel.open;
  const sessionRef = useRef<PdfSession | null>(null);
  sessionRef.current = session;

  const fail = useCallback(
    (caught: unknown) => {
      const message = errorMessage(t, caught);
      if (message) toast(message, "danger");
    },
    [t, toast],
  );

  // pdf.js keeps work and memory per document: let it go with the window.
  useEffect(() => () => sessionRef.current?.destroy(), []);

  useEffect(() => {
    void app.window.setTitle(doc ? (doc.session.title ?? doc.name) : t("app.name"));
  }, [app, doc, t]);

  // The document's events: page, zoom, rotation, search results.
  useEffect(() => {
    if (!session) return;
    return session.on((event) => {
      switch (event.kind) {
        case "page":
          setPage(event.page);
          setPageInput(String(event.page));
          break;
        case "scale":
          setScale(event.scale);
          if (stepping.current) {
            stepping.current = false;
            setZoomChoice(event.scale);
          }
          break;
        case "rotation":
          setRotation(event.rotation);
          break;
        case "find":
          setFindStatus({ state: event.state, current: event.current, total: event.total });
          break;
        case "matches":
          setFindStatus((current) => ({
            state: current?.state === "notFound" ? "found" : (current?.state ?? "found"),
            current: event.current,
            total: event.total,
          }));
          break;
      }
    });
  }, [session]);

  // Where the person is in the document, and their bookmarks, kept for next time.
  const docState = useRef<{ key: string; state: DocState } | null>(null);
  useLayoutEffect(() => {
    if (!session) return;
    docState.current = {
      key: docKey(session.fingerprint),
      state: { page, zoom, rotation, bookmarks },
    };
  }, [session, page, zoom, rotation, bookmarks]);
  const saveState = useCallback(() => {
    const pending = docState.current;
    if (pending) void app.storage.set(pending.key, pending.state).catch(() => undefined);
  }, [app]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(saveState, 600);
    return () => clearTimeout(timer);
  }, [session, page, zoom, rotation, bookmarks, saveState]);
  useEffect(() => {
    const stop = app.lifecycle.onSuspend(saveState);
    window.addEventListener("pagehide", saveState);
    return () => {
      stop();
      window.removeEventListener("pagehide", saveState);
    };
  }, [app, saveState]);

  const askPassword = (reason: "need" | "incorrect") =>
    new Promise<string | null>((resolve) => {
      setPasswordText("");
      setPassword({ reason, resolve });
    });

  const openHandle = async (handle: FileHandle) => {
    setFailure(null);
    setOpening(true);
    try {
      if (handle.size !== null && handle.size > MAX_PDF_BYTES) throw new TooLargeError();
      const data = new Uint8Array(await app.files.read(handle));
      const engine = await loadEngine();
      saveState();
      doc?.session.destroy();
      setDoc(null);
      setFindOpen(false);
      setFindStatus(null);
      const opened = await engine.open(data, container.current!, { onPassword: askPassword });
      const state = sanitizeDocState(
        await app.storage.get(docKey(opened.fingerprint)).catch(() => null),
      );
      opened.setRotation(state.rotation);
      opened.setZoom(state.zoom);
      if (state.page > 1 && state.page <= opened.pageCount) opened.goTo(state.page);
      setDoc({ session: opened, name: handle.name, handleId: handle.id });
      setBookmarks(state.bookmarks);
      setZoomChoice(state.zoom);
      setPage(opened.page);
      setPageInput(String(opened.page));
      setScale(opened.scale);
      setRotation(opened.rotation);
      setRecent((list) =>
        addRecent(Array.isArray(list) ? list.filter(isRecent) : [], {
          handleId: handle.id,
          name: handle.name,
          fingerprint: opened.fingerprint,
          openedAt: Date.now(),
        }),
      );
    } catch (caught) {
      const name = (caught as { name?: string } | null)?.name;
      // Cancelled at the password question: back to where the person was.
      if (name === "AbortException") return;
      setFailure(
        caught instanceof TooLargeError
          ? t("errors.tooLarge", { size: formatBytes(MAX_PDF_BYTES) })
          : name === "InvalidPDFException"
            ? t("errors.invalid", { name: handle.name })
            : name === "PasswordException"
              ? t("errors.password")
              : errorMessage(t, caught) || t("errors.open", { name: handle.name }),
      );
    } finally {
      setOpening(false);
    }
  };

  const openFile = async () => {
    try {
      const [handle] = await app.files.open({ accept: [".pdf"], persist: true });
      if (handle) await openHandle(handle);
    } catch (caught) {
      fail(caught);
    }
  };

  const openRecent = async (entry: Recent) => {
    try {
      const handle = (await app.files.handles()).find((item) => item.id === entry.handleId);
      if (!handle) {
        toast(t("recent.gone", { name: entry.name }), "danger");
        setRecent((list) => list.filter((item) => item.handleId !== entry.handleId));
        return;
      }
      await openHandle(handle);
    } catch (caught) {
      fail(caught);
    }
  };

  const goTo = (target: number) => session?.goTo(target);
  const changeZoom = (value: ZoomValue) => {
    if (!session) return;
    if (value === "in" || value === "out") stepping.current = true;
    else setZoomChoice(value);
    session.setZoom(value);
  };
  const rotate = (direction: 1 | -1) => session?.setRotation(nextRotation(rotation, direction));

  const openFind = () => {
    if (!session) return;
    setFindOpen(true);
    requestAnimationFrame(() =>
      document.querySelector<HTMLInputElement>("[data-find-input]")?.select(),
    );
  };
  const closeFind = () => {
    setFindOpen(false);
    setFindStatus(null);
    session?.clearFind();
  };
  // A new search while typing (a moment after the last key).
  useEffect(() => {
    if (!session || !findOpen) return;
    const timer = setTimeout(() => {
      if (query.text.trim()) session.find(query);
      else {
        session.clearFind();
        setFindStatus(null);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [session, findOpen, query]);

  const bookmarked = bookmarks.some((bookmark) => bookmark.page === page);
  const toggleBookmark = () => {
    if (!session) return;
    if (bookmarked) setBookmarks((list) => removeBookmark(list, page));
    else {
      setBookmarks((list) =>
        setBookmark(list, {
          page,
          label: t("bookmarks.defaultLabel", { page }),
          createdAt: Date.now(),
        }),
      );
      toast(t("bookmarks.added", { page }));
    }
  };
  const renameBookmark = async (bookmark: Bookmark) => {
    const label = await app.dialogs.prompt(t("bookmarks.renameTitle"), undefined, {
      value: bookmark.label,
    });
    if (label?.trim()) setBookmarks((list) => setBookmark(list, { ...bookmark, label }));
  };

  const openOutline = (item: OutlineItem) => {
    if (item.url) window.open(item.url, "_blank", "noopener,noreferrer");
    else if (item.dest) void session?.goToDestination(item.dest).catch(() => undefined);
    if (narrow) setPanel((current) => ({ ...current, open: false }));
  };

  const print = async () => {
    if (!session || printing || !printTarget.current) return;
    const controller = new AbortController();
    printAbort.current = controller;
    setPrinting({ done: 0, total: session.pageCount });
    try {
      const cleanup = await preparePrint(
        session,
        printTarget.current,
        (done) => setPrinting({ done, total: session.pageCount }),
        controller.signal,
      );
      setPrinting(null);
      const after = () => {
        window.removeEventListener("afterprint", after);
        cleanup();
      };
      window.addEventListener("afterprint", after);
      window.print();
    } catch (caught) {
      setPrinting(null);
      if ((caught as { name?: string } | null)?.name !== "AbortError")
        toast(t("print.failed"), "danger");
    }
  };

  const saveCopy = async () => {
    if (!doc) return;
    try {
      let bytes: Uint8Array;
      if (doc.session.hasFormChanges()) bytes = await doc.session.saveWithChanges();
      else {
        const handle = (await app.files.handles()).find((item) => item.id === doc.handleId);
        if (!handle) throw new Error(t("recent.gone", { name: doc.name }));
        bytes = new Uint8Array(await app.files.read(handle));
      }
      if (await saveTextFile(app, doc.name, bytes, { accept: [".pdf"] }))
        toast(t("save.saved", { name: doc.name }));
    } catch (caught) {
      fail(caught);
    }
  };

  useShortcuts({
    "mod+o": () => void openFile(),
    "mod+f": openFind,
    "mod+p": () => void print(),
    "mod+s": () => void saveCopy(),
    "mod+=": () => changeZoom("in"),
    "mod+-": () => changeZoom("out"),
    "mod+0": () => changeZoom("auto"),
  });

  const zoomOptions = [
    ...ZOOM_PRESETS.map((value) => ({ value, label: t(`zoom.${value}`) })),
    ...ZOOM_LEVELS.map((level) => ({
      value: String(level),
      label: `${i18n.number(level * 100)} %`,
    })),
  ];
  const zoomValue = typeof zoom === "number" ? String(zoom) : zoom;
  if (typeof zoom === "number" && !ZOOM_LEVELS.includes(zoom as (typeof ZOOM_LEVELS)[number]))
    zoomOptions.push({ value: zoomValue, label: `${i18n.number(Math.round(zoom * 100))} %` });

  const findText =
    !findStatus || !query.text.trim()
      ? ""
      : findStatus.state === "pending"
        ? t("find.searching")
        : findStatus.state === "notFound"
          ? t("find.notFound")
          : t("find.position", { current: findStatus.current, count: findStatus.total });

  return (
    <div className="pdf-app" data-narrow={narrow || undefined}>
      <Toolbar label={t("app.name")}>
        {doc ? (
          <IconButton
            label={panel.open ? t("sidebar.hide") : t("sidebar.show")}
            icon={<PanelLeft size={16} aria-hidden />}
            aria-pressed={panel.open}
            onClick={() => setPanel((current) => ({ ...current, open: !current.open }))}
          />
        ) : null}
        <ToolbarTitle>{doc ? (doc.session.title ?? doc.name) : t("app.name")}</ToolbarTitle>
        <IconButton
          label={`${t("actions.open")} (${shortcutLabel("mod+o")})`}
          icon={<FolderOpen size={16} aria-hidden />}
          onClick={() => void openFile()}
        />
        {doc ? (
          <>
            <Spacer />
            <div className="pdf-nav" role="group" aria-label={t("pages.label")}>
              <IconButton
                label={t("pages.previous")}
                icon={<ChevronLeft size={16} aria-hidden />}
                disabled={page <= 1}
                onClick={() => goTo(page - 1)}
              />
              <input
                className="eui-input pdf-page-input"
                aria-label={t("pages.current")}
                inputMode="numeric"
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                onFocus={(event) => event.target.select()}
                onBlur={() => setPageInput(String(page))}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const target = parsePage(pageInput, doc.session.pageCount);
                  if (target) goTo(target);
                  else setPageInput(String(page));
                }}
              />
              <span className="pdf-page-count">
                {t("pages.of", { count: doc.session.pageCount })}
              </span>
              <IconButton
                label={t("pages.next")}
                icon={<ChevronRight size={16} aria-hidden />}
                disabled={page >= doc.session.pageCount}
                onClick={() => goTo(page + 1)}
              />
            </div>
            {!narrow ? (
              <div className="pdf-zoom" role="group" aria-label={t("zoom.label")}>
                <IconButton
                  label={`${t("zoom.out")} (${shortcutLabel("mod+-")})`}
                  icon={<ZoomOut size={16} aria-hidden />}
                  onClick={() => changeZoom("out")}
                />
                <Select
                  label={t("zoom.label")}
                  hideLabel
                  value={zoomValue}
                  onChange={(value) =>
                    changeZoom(
                      (ZOOM_PRESETS as readonly string[]).includes(value)
                        ? (value as ZoomValue)
                        : Number(value),
                    )
                  }
                  options={zoomOptions}
                />
                <IconButton
                  label={`${t("zoom.in")} (${shortcutLabel("mod+=")})`}
                  icon={<ZoomIn size={16} aria-hidden />}
                  onClick={() => changeZoom("in")}
                />
              </div>
            ) : null}
            <IconButton
              label={t("rotate.left")}
              icon={<RotateCcw size={16} aria-hidden />}
              onClick={() => rotate(-1)}
            />
            <IconButton
              label={t("rotate.right")}
              icon={<RotateCw size={16} aria-hidden />}
              onClick={() => rotate(1)}
            />
            <Spacer />
            <IconButton
              label={`${t("find.open")} (${shortcutLabel("mod+f")})`}
              icon={<Search size={16} aria-hidden />}
              aria-pressed={findOpen}
              onClick={() => (findOpen ? closeFind() : openFind())}
            />
            <IconButton
              label={bookmarked ? t("bookmarks.removeCurrent") : t("bookmarks.addCurrent")}
              icon={
                bookmarked ? (
                  <BookmarkCheck size={16} aria-hidden />
                ) : (
                  <BookmarkIcon size={16} aria-hidden />
                )
              }
              aria-pressed={bookmarked}
              onClick={toggleBookmark}
            />
            <IconButton
              label={`${t("print.action")} (${shortcutLabel("mod+p")})`}
              icon={<Printer size={16} aria-hidden />}
              onClick={() => void print()}
            />
            <IconButton
              label={`${t("save.action")} (${shortcutLabel("mod+s")})`}
              icon={<Download size={16} aria-hidden />}
              onClick={() => void saveCopy()}
            />
          </>
        ) : null}
      </Toolbar>
      {doc && findOpen ? (
        <div className="pdf-findbar" role="search">
          <TextField
            data-find-input
            autoFocus
            label={t("find.label")}
            hideLabel
            placeholder={t("find.placeholder")}
            value={query.text}
            onChange={(event) => setQuery((current) => ({ ...current, text: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && query.text.trim()) {
                event.preventDefault();
                doc.session.find(query, event.shiftKey ? "previous" : "next");
              } else if (event.key === "Escape") closeFind();
            }}
          />
          <IconButton
            label={t("find.previous")}
            icon={<ChevronUp size={15} aria-hidden />}
            disabled={!query.text.trim()}
            onClick={() => doc.session.find(query, "previous")}
          />
          <IconButton
            label={t("find.next")}
            icon={<ChevronDown size={15} aria-hidden />}
            disabled={!query.text.trim()}
            onClick={() => doc.session.find(query, "next")}
          />
          <Checkbox
            label={t("find.caseSensitive")}
            checked={query.caseSensitive}
            onChange={(caseSensitive) => setQuery((current) => ({ ...current, caseSensitive }))}
          />
          <Checkbox
            label={t("find.entireWord")}
            checked={query.entireWord}
            onChange={(entireWord) => setQuery((current) => ({ ...current, entireWord }))}
          />
          <span className="pdf-find-status" role="status" data-state={findStatus?.state}>
            {findText}
          </span>
          <Spacer />
          <IconButton
            label={t("find.close")}
            icon={<X size={15} aria-hidden />}
            onClick={closeFind}
          />
        </div>
      ) : null}
      <div className="pdf-body" data-sidebar={sidebarOpen || undefined}>
        {doc && sidebarOpen ? (
          <Sidebar
            session={doc.session}
            tab={panel.tab}
            onTab={(tab) => setPanel((current) => ({ ...current, tab }))}
            page={page}
            rotation={rotation}
            bookmarks={bookmarks}
            onGoTo={(target) => {
              goTo(target);
              if (narrow) setPanel((current) => ({ ...current, open: false }));
            }}
            onOutline={openOutline}
            onRenameBookmark={(bookmark) => void renameBookmark(bookmark)}
            onRemoveBookmark={(bookmark) =>
              setBookmarks((list) => removeBookmark(list, bookmark.page))
            }
          />
        ) : null}
        <div className="pdf-stage">
          <div
            ref={container}
            className="pdf-scroll"
            tabIndex={0}
            aria-label={doc ? t("viewer.label", { name: doc.name }) : undefined}
            data-scale={scale}
          >
            <div className="pdfViewer" />
          </div>
          {!doc ? (
            <div className="pdf-cover">
              {opening ? (
                <LoadingState text={t("viewer.opening")} />
              ) : (
                <EmptyState
                  icon={<FileText size={32} aria-hidden />}
                  title={failure ?? t("viewer.emptyTitle")}
                  text={failure ? t("viewer.tryAnother") : t("viewer.emptyText")}
                  action={
                    <div className="pdf-start">
                      <Button
                        variant="primary"
                        icon={<FolderOpen size={15} aria-hidden />}
                        onClick={() => void openFile()}
                      >
                        {t("actions.open")}
                      </Button>
                      {recent.length ? (
                        <section className="pdf-recent" aria-label={t("recent.title")}>
                          <h2>{t("recent.title")}</h2>
                          <ul className="eui-list">
                            {recent.map((entry) => (
                              <li key={entry.handleId}>
                                <ListItem
                                  title={entry.name}
                                  meta={i18n.date(entry.openedAt, { dateStyle: "medium" })}
                                  onClick={() => void openRecent(entry)}
                                />
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}
                    </div>
                  }
                />
              )}
            </div>
          ) : opening ? (
            <div className="pdf-cover pdf-cover-dim">
              <LoadingState text={t("viewer.opening")} />
            </div>
          ) : null}
        </div>
      </div>
      <div ref={printTarget} className="pdf-print" aria-hidden />
      <Dialog
        open={printing !== null}
        title={t("print.preparing")}
        onClose={() => printAbort.current?.abort()}
        actions={<Button onClick={() => printAbort.current?.abort()}>{t("ui.cancel")}</Button>}
      >
        <progress
          className="pdf-progress"
          max={printing?.total ?? 1}
          value={printing?.done ?? 0}
          aria-label={t("print.preparing")}
        />
        <p className="eui-hint">
          {t("print.progress", { done: printing?.done ?? 0, total: printing?.total ?? 0 })}
        </p>
      </Dialog>
      <Dialog
        open={password !== null}
        title={t("password.title")}
        onClose={() => {
          password?.resolve(null);
          setPassword(null);
        }}
        actions={
          <>
            <Button
              onClick={() => {
                password?.resolve(null);
                setPassword(null);
              }}
            >
              {t("ui.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={!passwordText}
              onClick={() => {
                password?.resolve(passwordText);
                setPassword(null);
              }}
            >
              {t("password.open")}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!passwordText) return;
            password?.resolve(passwordText);
            setPassword(null);
          }}
        >
          <TextField
            label={t("password.label")}
            type="password"
            autoComplete="off"
            value={passwordText}
            error={password?.reason === "incorrect" ? t("password.incorrect") : undefined}
            onChange={(event) => setPasswordText(event.target.value)}
          />
        </form>
      </Dialog>
    </div>
  );
}
