import { indentUnit } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { useT } from "@everyos/app-ui";
import { CodeEditor, EditorView, loadLanguage } from "@everyos/app-ui/editor";
import { showMinimap } from "@replit/codemirror-minimap";
import { useEffect, useMemo, useState } from "react";
import type { Doc } from "./documents.ts";

export type ThemeName = "system" | "light" | "dark" | "contrast";
export const THEMES: readonly ThemeName[] = ["system", "light", "dark", "contrast"];

export interface Settings {
  theme: ThemeName;
  fontSize: number;
  tabSize: number;
  insertSpaces: boolean;
  wrap: boolean;
  minimap: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  fontSize: 14,
  tabSize: 2,
  insertSpaces: true,
  wrap: false,
  minimap: true,
};

export const FONT_SIZES: readonly number[] = [11, 12, 13, 14, 15, 16, 18, 20, 22];
export const TAB_SIZES: readonly number[] = [2, 4, 8];

/** Stored settings, each value checked (anything unknown falls back to its default). */
export function sanitizeSettings(value: unknown): Settings {
  const stored = (typeof value === "object" && value !== null ? value : {}) as Partial<Settings>;
  const pick = <T,>(candidate: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(candidate as T) ? (candidate as T) : fallback;
  const flag = (candidate: unknown, fallback: boolean) =>
    typeof candidate === "boolean" ? candidate : fallback;
  return {
    theme: pick(stored.theme, THEMES, DEFAULT_SETTINGS.theme),
    fontSize: pick(stored.fontSize, FONT_SIZES, DEFAULT_SETTINGS.fontSize),
    tabSize: pick(stored.tabSize, TAB_SIZES, DEFAULT_SETTINGS.tabSize),
    insertSpaces: flag(stored.insertSpaces, DEFAULT_SETTINGS.insertSpaces),
    wrap: flag(stored.wrap, DEFAULT_SETTINGS.wrap),
    minimap: flag(stored.minimap, DEFAULT_SETTINGS.minimap),
  };
}

export interface Cursor {
  line: number;
  column: number;
  selected: number;
}

/** Settings that apply to an editor for its life (the app remounts editors when they change). */
function settingsExtensions(settings: Settings): Extension {
  return [
    EditorState.tabSize.of(settings.tabSize),
    indentUnit.of(settings.insertSpaces ? " ".repeat(settings.tabSize) : "\t"),
    EditorView.theme({ "&": { fontSize: `${settings.fontSize}px` } }),
    settings.minimap
      ? showMinimap.of({
          create: () => ({ dom: document.createElement("div") }),
          displayText: "blocks",
          showOverlay: "always",
        })
      : [],
  ];
}

/** One tab's editor: the language follows the file name unless one was picked. */
export function DocEditor({
  doc,
  settings,
  hidden,
  onChange,
  onView,
  onCursor,
}: {
  doc: Doc;
  settings: Settings;
  hidden: boolean;
  onChange: (text: string) => void;
  onView: (view: EditorView | null) => void;
  onCursor: (cursor: Cursor) => void;
}) {
  const t = useT();
  const [language, setLanguage] = useState<Extension | null>(null);
  const languageName = doc.language === "plain" ? null : (doc.language ?? doc.name);
  useEffect(() => {
    let live = true;
    loadLanguage(languageName)
      .then((loaded) => {
        if (live) setLanguage(loaded);
      })
      .catch(() => {
        if (live) setLanguage(null);
      });
    return () => {
      live = false;
    };
  }, [languageName]);

  const extensions = useMemo(
    () => [
      settingsExtensions(settings),
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet && !update.docChanged && !update.focusChanged) return;
        if (!update.view.hasFocus && !update.docChanged) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        onCursor({
          line: line.number,
          column: head - line.from + 1,
          selected: update.state.selection.ranges.reduce(
            (sum, range) => sum + range.to - range.from,
            0,
          ),
        });
      }),
    ],
    // Fixed for the editor's life; the parent remounts it with a new key for new settings.
    [],
  );

  return (
    <div className="code-editor" hidden={hidden}>
      <CodeEditor
        value={doc.text}
        label={t("editor.label", { name: doc.name })}
        language={language}
        setup={{ gutters: true, wrap: settings.wrap, tabIndents: true, autocomplete: true }}
        extensions={extensions}
        onChange={onChange}
        onView={onView}
      />
    </div>
  );
}
