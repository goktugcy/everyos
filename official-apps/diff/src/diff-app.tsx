import type { Extension } from "@codemirror/state";
import {
  Badge,
  Button,
  IconButton,
  LoadingState,
  Select,
  Spacer,
  Switch,
  Tabs,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  openTextFile,
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
import { EDITOR_LANGUAGES, loadLanguage } from "@everyos/app-ui/editor";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Copy,
  FileDown,
  FilePlus2,
  FolderOpen,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diffStats, lineEnding, unifiedPatch, type LineEnding } from "./diff.ts";
import { DiffSurface, type DiffInfo, type SurfaceControls, type ViewMode } from "./surface.tsx";

interface Side {
  /** The file it came from; null for typed or pasted text. */
  name: string | null;
  text: string;
  /** Line endings of the file as opened (the editor shows them as plain line breaks). */
  ending: LineEnding | null;
}

type SideKey = "left" | "right";

const EMPTY: Side = { name: null, text: "", ending: null };
/** Larger files make the in-browser diff slow; they are refused with a message. */
export const MAX_FILE = 5 * 1024 * 1024;
/** App storage keeps values up to 256 KB; a larger side stays in the window only. */
const KEEP_LIMIT = 240 * 1024;

const isSide = (value: unknown): value is Side =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Side).text === "string" &&
  ((value as Side).name === null || typeof (value as Side).name === "string");

/** The language name for a file name, by extension or whole name (Dockerfile, Makefile). */
function languageFor(name: string | null): string | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return (
    EDITOR_LANGUAGES.find(
      (language) =>
        language.extensions.includes(extension) || language.name.toLowerCase() === lower,
    )?.name ?? null
  );
}

export function DiffApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const narrow = useNarrow(720);
  const [storedMode, setMode] = usePersistentState<ViewMode>("mode", "split");
  const [ignoreWhitespace, setIgnoreWhitespace] = usePersistentState("ignoreWhitespace", false);
  const [collapse, setCollapse] = usePersistentState("collapse", false);
  const [wrap, setWrap] = usePersistentState("wrap", false);
  const [languageChoice, setLanguageChoice] = usePersistentState("language", "auto");
  const [loaded, setLoaded] = useState(false);
  const [left, setLeft] = useState<Side>(EMPTY);
  const [right, setRight] = useState<Side>(EMPTY);
  // Bumped when a side is replaced from outside the editors (open, swap, new): the surface remounts.
  const [generation, setGeneration] = useState(0);
  const [info, setInfo] = useState<DiffInfo | null>(null);
  const [notKept, setNotKept] = useState<Record<SideKey, boolean>>({ left: false, right: false });
  const [busy, setBusy] = useState(false);
  const controls = useRef<SurfaceControls | null>(null);
  // Small screens get the inline view; side by side needs the width.
  const mode: ViewMode = narrow ? "inline" : storedMode;

  useEffect(() => {
    void Promise.all([app.storage.get("left"), app.storage.get("right")])
      .then(([storedLeft, storedRight]) => {
        if (isSide(storedLeft)) setLeft({ ...storedLeft, ending: storedLeft.ending ?? null });
        if (isSide(storedRight)) setRight({ ...storedRight, ending: storedRight.ending ?? null });
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [app]);

  // Both sides are kept for next time while they fit in app storage.
  useKept(loaded, "left", left, (kept) => setNotKept((current) => ({ ...current, left: !kept })));
  useKept(loaded, "right", right, (kept) =>
    setNotKept((current) => ({ ...current, right: !kept })),
  );

  const detected = languageFor(right.name) ?? languageFor(left.name);
  const languageName =
    languageChoice === "auto" ? detected : languageChoice === "plain" ? null : languageChoice;
  const [language, setLanguage] = useState<Extension | null>(null);
  useEffect(() => {
    let live = true;
    loadLanguage(languageName)
      .then((loadedLanguage) => {
        if (live) setLanguage(loadedLanguage);
      })
      .catch(() => {
        if (live) setLanguage(null);
      });
    return () => {
      live = false;
    };
  }, [languageName]);

  const stats = info ? diffStats(info.chunks, info.a, info.b) : null;
  const differs = left.text !== right.text;

  const replace = (side: SideKey, next: Side) => {
    (side === "left" ? setLeft : setRight)(next);
    setGeneration((current) => current + 1);
  };

  const open = async (side: SideKey) => {
    try {
      const file = await openTextFile(app, { maxBytes: MAX_FILE });
      if (!file) return;
      if (file.text.includes("\u0000")) {
        toast(t("files.binary", { name: file.name }), "danger");
        return;
      }
      replace(side, { name: file.name, text: file.text, ending: lineEnding(file.text) });
    } catch (caught) {
      const message = errorMessage(t, caught);
      if (message) toast(message, "danger");
    }
  };

  const swap = () => {
    setLeft(right);
    setRight(left);
    setGeneration((current) => current + 1);
  };

  const startOver = async () => {
    if (
      (left.text || right.text) &&
      !(await app.dialogs.confirm(t("actions.newTitle"), t("actions.newBody"), {
        confirm: t("actions.new"),
      }))
    )
      return;
    setLeft(EMPTY);
    setRight(EMPTY);
    setGeneration((current) => current + 1);
  };

  const patch = async (how: "copy" | "save") => {
    setBusy(true);
    try {
      const text = await unifiedPatch(left.text, right.text, {
        a: left.name ?? "original",
        b: right.name ?? "changed",
      });
      if (text === null) {
        toast(t("patch.tooDifferent"), "danger");
        return;
      }
      if (how === "copy") {
        await app.clipboard.writeText(text);
        toast(t("ui.copied"));
      } else {
        const base = (right.name ?? left.name ?? "changes").replace(/\.[^.]*$/, "");
        if (await saveTextFile(app, `${base}.patch`, text, { accept: [".patch", ".diff"] }))
          toast(t("ui.exported"));
      }
    } catch (caught) {
      const message = errorMessage(t, caught);
      if (message) toast(message, "danger");
    } finally {
      setBusy(false);
    }
  };

  useShortcuts({
    F7: () => controls.current?.next(),
    "Shift+F7": () => controls.current?.previous(),
  });

  const labels = useMemo(() => ({ a: t("sides.original"), b: t("sides.changed") }), [t]);
  const surfaceKey = `${generation}:${mode}:${ignoreWhitespace}:${collapse}:${wrap}`;
  const endingsDiffer = left.ending && right.ending && left.ending !== right.ending;

  const sideHeader = (side: SideKey) => {
    const value = side === "left" ? left : right;
    return (
      <div className="diff-side" data-side={side}>
        <span className="diff-side-label">
          {side === "left" ? t("sides.original") : t("sides.changed")}
        </span>
        <span className="diff-side-name" title={value.name ?? undefined}>
          {value.name ?? t("sides.typed")}
        </span>
        {value.ending ? <Badge>{value.ending}</Badge> : null}
        {notKept[side] ? (
          <span title={t("sides.notKeptHint")}>
            <Badge tone="warning">{t("sides.notKept")}</Badge>
          </span>
        ) : null}
        <Spacer />
        <Button
          size="sm"
          variant="ghost"
          icon={<FolderOpen size={14} aria-hidden />}
          aria-label={side === "left" ? t("sides.openOriginal") : t("sides.openChanged")}
          onClick={() => void open(side)}
        >
          {t("sides.open")}
        </Button>
      </div>
    );
  };

  return (
    <div className="diff-app">
      <Toolbar label={t("app.name")}>
        <ToolbarTitle>{t("app.name")}</ToolbarTitle>
        {!narrow ? (
          <Tabs<ViewMode>
            label={t("view.label")}
            value={mode}
            onChange={setMode}
            tabs={[
              { value: "split", label: t("view.split") },
              { value: "inline", label: t("view.inline") },
            ]}
          />
        ) : null}
        <Spacer />
        <IconButton
          label={t("nav.previous", { key: shortcutLabel("Shift+F7") })}
          icon={<ChevronUp size={16} aria-hidden />}
          disabled={!stats?.changes}
          onClick={() => controls.current?.previous()}
        />
        <span className="diff-position" aria-live="polite">
          {!stats?.changes
            ? ""
            : info?.current !== null && info?.current !== undefined
              ? t("nav.position", { current: info.current + 1, total: stats.changes })
              : t("nav.count", { count: stats.changes })}
        </span>
        <IconButton
          label={t("nav.next", { key: shortcutLabel("F7") })}
          icon={<ChevronDown size={16} aria-hidden />}
          disabled={!stats?.changes}
          onClick={() => controls.current?.next()}
        />
        <IconButton
          label={t("patch.copy")}
          icon={<Copy size={15} aria-hidden />}
          disabled={!differs || busy}
          onClick={() => void patch("copy")}
        />
        <IconButton
          label={t("patch.save")}
          icon={<FileDown size={16} aria-hidden />}
          disabled={!differs || busy}
          onClick={() => void patch("save")}
        />
        <IconButton
          label={t("actions.new")}
          icon={<FilePlus2 size={16} aria-hidden />}
          onClick={() => void startOver()}
        />
      </Toolbar>
      <div className="diff-options">
        {(
          [
            ["ignoreWhitespace", ignoreWhitespace, setIgnoreWhitespace],
            ["collapse", collapse, setCollapse],
            ["wrap", wrap, setWrap],
          ] as const
        ).map(([name, checked, set]) => (
          <label key={name} className="diff-switch">
            <Switch label={t(`options.${name}`)} checked={checked} onChange={set} />
            <span aria-hidden>{t(`options.${name}`)}</span>
          </label>
        ))}
        <Select
          label={t("options.language")}
          value={languageChoice}
          onChange={setLanguageChoice}
          options={[
            {
              value: "auto",
              label: detected ? t("options.autoNamed", { name: detected }) : t("options.auto"),
            },
            { value: "plain", label: t("options.plain") },
            ...EDITOR_LANGUAGES.map((entry) => ({ value: entry.name, label: entry.name })),
          ]}
        />
        <Spacer />
        <div className="diff-status" role="status">
          {!left.text && !right.text ? (
            <span className="eui-hint">{t("status.empty")}</span>
          ) : !differs ? (
            <Badge tone="success">{t("status.identical")}</Badge>
          ) : stats && stats.changes === 0 ? (
            <Badge>{t("status.whitespaceOnly")}</Badge>
          ) : stats ? (
            <>
              <span className="diff-added" title={t("stats.added", { count: stats.added })}>
                +{i18n.number(stats.added)}
              </span>
              <span className="diff-removed" title={t("stats.removed", { count: stats.removed })}>
                −{i18n.number(stats.removed)}
              </span>
              <span className="eui-visually-hidden">
                {`${t("stats.added", { count: stats.added })}, ${t("stats.removed", { count: stats.removed })}`}
              </span>
            </>
          ) : null}
          {info && !info.precise ? <Badge tone="warning">{t("status.approximate")}</Badge> : null}
        </div>
      </div>
      {endingsDiffer ? (
        <p className="diff-note eui-hint">
          {t("status.endings", { a: left.ending ?? "", b: right.ending ?? "" })}
        </p>
      ) : null}
      <div className="diff-sides" data-mode={mode}>
        {sideHeader("left")}
        <IconButton
          size="sm"
          label={t("sides.swap")}
          icon={<ArrowLeftRight size={14} aria-hidden />}
          onClick={swap}
        />
        {sideHeader("right")}
      </div>
      {loaded ? (
        <DiffSurface
          key={surfaceKey}
          left={left.text}
          right={right.text}
          options={{ mode, ignoreWhitespace, collapse, wrap }}
          language={language}
          labels={labels}
          placeholders={{ a: t("sides.placeholderOriginal"), b: t("sides.placeholderChanged") }}
          onLeft={(text) => setLeft((current) => ({ ...current, text }))}
          onRight={(text) => setRight((current) => ({ ...current, text }))}
          onInfo={setInfo}
          controls={controls}
        />
      ) : (
        <LoadingState />
      )}
    </div>
  );
}

/**
 * Keeps a side in app storage while it fits: written after a short pause, and right away when the
 * window goes to the background, closes or the app unmounts. Reports whether the side is kept.
 */
function useKept(loaded: boolean, key: SideKey, side: Side, report: (kept: boolean) => void) {
  const app = useApp();
  const pending = useRef<Side | null>(null);
  const latest = useRef(report);
  useEffect(() => {
    latest.current = report;
  });
  const flush = useCallback(() => {
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    if (new TextEncoder().encode(JSON.stringify(next)).length > KEEP_LIMIT) {
      latest.current(false);
      void app.storage.delete(key).catch(() => undefined);
      return;
    }
    latest.current(true);
    const write = next.text || next.name ? app.storage.set(key, next) : app.storage.delete(key);
    void write.catch(() => undefined);
  }, [app, key]);
  useEffect(() => {
    if (!loaded) return;
    pending.current = side;
    const timer = setTimeout(flush, 400);
    return () => clearTimeout(timer);
  }, [flush, loaded, side]);
  useEffect(() => {
    const stopSuspend = app.lifecycle.onSuspend(flush);
    window.addEventListener("pagehide", flush);
    return () => {
      stopSuspend();
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [app, flush]);
}
