import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
  type LanguageSupport,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderText,
  rectangularSelection,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { useI18n, useT } from "./app.tsx";

/*
 * CodeMirror 6 for official apps: the desktop's theme tokens (light and dark follow the person's
 * theme), CodeMirror's own texts in the ten languages of EveryOS, languages loaded on demand, and
 * a React component. Import from `@everyos/app-ui/editor` (only apps with an editor bundle it).
 */

/** Marks a text set from outside (a new `value`): not an edit, and not undoable. */
const fromOutside = Annotation.define<boolean>();

/** The editor's colors come from the desktop's tokens; see `.eui-code-*` in styles.css. */
export const everyosEditorTheme: Extension = EditorView.theme({
  "&": {
    color: "var(--eui-text)",
    backgroundColor: "transparent",
    height: "100%",
    fontSize: "0.92rem",
  },
  ".cm-scroller": {
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    lineHeight: "1.55",
  },
  ".cm-content": { caretColor: "var(--eui-accent)", padding: "8px 0" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--eui-accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "rgb(var(--everyos-accent, 2 132 199) / 0.28)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--eui-subtle)",
    borderRight: "1px solid var(--eui-line)",
  },
  ".cm-activeLine": { backgroundColor: "var(--eui-hover)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--eui-hover)", color: "var(--eui-text)" },
  ".cm-searchMatch": { backgroundColor: "rgb(250 204 21 / 0.35)", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgb(249 115 22 / 0.45)" },
  ".cm-selectionMatch": { backgroundColor: "rgb(var(--everyos-accent, 2 132 199) / 0.14)" },
  ".cm-matchingBracket": {
    backgroundColor: "rgb(var(--everyos-accent, 2 132 199) / 0.2)",
    outline: "1px solid rgb(var(--everyos-accent, 2 132 199) / 0.5)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--eui-hover-strong)",
    border: "none",
    color: "var(--eui-muted)",
  },
  ".cm-panels": {
    backgroundColor: "var(--eui-surface)",
    color: "var(--eui-text)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--eui-line)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--eui-line)" },
  ".cm-panel input, .cm-panel button, .cm-textfield": {
    font: "inherit",
    fontSize: "0.85rem",
    color: "var(--eui-text)",
    backgroundColor: "var(--eui-inset)",
    border: "1px solid var(--eui-line)",
    borderRadius: "8px",
    padding: "3px 8px",
  },
  ".cm-button": { backgroundImage: "none" },
  ".cm-panel label": { fontSize: "0.85rem", color: "var(--eui-muted)" },
  ".cm-tooltip": {
    backgroundColor: "var(--eui-surface)",
    color: "var(--eui-text)",
    border: "1px solid var(--eui-line)",
    borderRadius: "8px",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "rgb(var(--everyos-accent, 2 132 199) / 0.2)",
    color: "var(--eui-text)",
  },
});

/** Syntax colors (CSS variables, so they follow light and dark). */
export const everyosHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: "var(--eui-code-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--eui-code-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--eui-code-number)" },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "var(--eui-code-comment)",
    fontStyle: "italic",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--eui-code-function)",
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--eui-code-type)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--eui-code-property)" },
  { tag: [tags.tagName, tags.angleBracket], color: "var(--eui-code-tag)" },
  { tag: [tags.definition(tags.variableName)], color: "var(--eui-code-definition)" },
  { tag: [tags.meta, tags.processingInstruction], color: "var(--eui-code-comment)" },
  { tag: tags.heading, fontWeight: "700", color: "var(--eui-code-keyword)" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--eui-accent)", textDecoration: "underline" },
  { tag: tags.invalid, color: "var(--eui-danger)" },
]);

/** CodeMirror's own texts (search panel, go to line, folding) in the person's language. */
const PHRASES: Record<string, Record<string, string>> = {
  tr: {
    Find: "Bul",
    Replace: "Değiştir",
    next: "sonraki",
    previous: "önceki",
    all: "tümü",
    "match case": "büyük/küçük harf",
    "by word": "tam kelime",
    regexp: "düzenli ifade",
    replace: "değiştir",
    "replace all": "tümünü değiştir",
    close: "kapat",
    "current match": "geçerli eşleşme",
    "replaced $ matches": "$ eşleşme değiştirildi",
    "replaced match on line $": "$. satırdaki eşleşme değiştirildi",
    "on line": "satırda",
    "Go to line": "Satıra git",
    go: "git",
    "Fold line": "Satırı katla",
    "Unfold line": "Satırı aç",
    "folded code": "katlanmış kod",
    unfold: "aç",
  },
  de: {
    Find: "Suchen",
    Replace: "Ersetzen",
    next: "weiter",
    previous: "zurück",
    all: "alle",
    "match case": "Groß-/Kleinschreibung",
    "by word": "ganzes Wort",
    regexp: "regulärer Ausdruck",
    replace: "ersetzen",
    "replace all": "alle ersetzen",
    close: "schließen",
    "current match": "aktueller Treffer",
    "replaced $ matches": "$ Treffer ersetzt",
    "replaced match on line $": "Treffer in Zeile $ ersetzt",
    "on line": "in Zeile",
    "Go to line": "Gehe zu Zeile",
    go: "los",
    "Fold line": "Zeile einklappen",
    "Unfold line": "Zeile ausklappen",
    "folded code": "eingeklappter Code",
    unfold: "ausklappen",
  },
  es: {
    Find: "Buscar",
    Replace: "Reemplazar",
    next: "siguiente",
    previous: "anterior",
    all: "todo",
    "match case": "mayúsculas/minúsculas",
    "by word": "palabra completa",
    regexp: "expresión regular",
    replace: "reemplazar",
    "replace all": "reemplazar todo",
    close: "cerrar",
    "current match": "coincidencia actual",
    "replaced $ matches": "$ coincidencias reemplazadas",
    "replaced match on line $": "coincidencia reemplazada en la línea $",
    "on line": "en la línea",
    "Go to line": "Ir a la línea",
    go: "ir",
    "Fold line": "Plegar línea",
    "Unfold line": "Desplegar línea",
    "folded code": "código plegado",
    unfold: "desplegar",
  },
  fr: {
    Find: "Rechercher",
    Replace: "Remplacer",
    next: "suivant",
    previous: "précédent",
    all: "tout",
    "match case": "respecter la casse",
    "by word": "mot entier",
    regexp: "expression régulière",
    replace: "remplacer",
    "replace all": "tout remplacer",
    close: "fermer",
    "current match": "occurrence actuelle",
    "replaced $ matches": "$ occurrences remplacées",
    "replaced match on line $": "occurrence remplacée à la ligne $",
    "on line": "à la ligne",
    "Go to line": "Aller à la ligne",
    go: "aller",
    "Fold line": "Replier la ligne",
    "Unfold line": "Déplier la ligne",
    "folded code": "code replié",
    unfold: "déplier",
  },
  it: {
    Find: "Trova",
    Replace: "Sostituisci",
    next: "successivo",
    previous: "precedente",
    all: "tutti",
    "match case": "maiuscole/minuscole",
    "by word": "parola intera",
    regexp: "espressione regolare",
    replace: "sostituisci",
    "replace all": "sostituisci tutto",
    close: "chiudi",
    "current match": "corrispondenza attuale",
    "replaced $ matches": "$ corrispondenze sostituite",
    "replaced match on line $": "corrispondenza sostituita alla riga $",
    "on line": "alla riga",
    "Go to line": "Vai alla riga",
    go: "vai",
    "Fold line": "Comprimi riga",
    "Unfold line": "Espandi riga",
    "folded code": "codice compresso",
    unfold: "espandi",
  },
  ja: {
    Find: "検索",
    Replace: "置換",
    next: "次へ",
    previous: "前へ",
    all: "すべて",
    "match case": "大文字と小文字を区別",
    "by word": "単語単位",
    regexp: "正規表現",
    replace: "置換",
    "replace all": "すべて置換",
    close: "閉じる",
    "current match": "現在の一致",
    "replaced $ matches": "$ 件を置換しました",
    "replaced match on line $": "$ 行目の一致を置換しました",
    "on line": "行",
    "Go to line": "行へ移動",
    go: "移動",
    "Fold line": "行を折りたたむ",
    "Unfold line": "行を展開",
    "folded code": "折りたたまれたコード",
    unfold: "展開",
  },
  ko: {
    Find: "찾기",
    Replace: "바꾸기",
    next: "다음",
    previous: "이전",
    all: "모두",
    "match case": "대소문자 구분",
    "by word": "단어 단위",
    regexp: "정규식",
    replace: "바꾸기",
    "replace all": "모두 바꾸기",
    close: "닫기",
    "current match": "현재 일치 항목",
    "replaced $ matches": "$개 항목을 바꿨습니다",
    "replaced match on line $": "$번째 줄의 항목을 바꿨습니다",
    "on line": "줄",
    "Go to line": "줄로 이동",
    go: "이동",
    "Fold line": "줄 접기",
    "Unfold line": "줄 펼치기",
    "folded code": "접힌 코드",
    unfold: "펼치기",
  },
  ru: {
    Find: "Найти",
    Replace: "Заменить",
    next: "далее",
    previous: "назад",
    all: "все",
    "match case": "учитывать регистр",
    "by word": "слово целиком",
    regexp: "регулярное выражение",
    replace: "заменить",
    "replace all": "заменить все",
    close: "закрыть",
    "current match": "текущее совпадение",
    "replaced $ matches": "заменено совпадений: $",
    "replaced match on line $": "заменено совпадение в строке $",
    "on line": "в строке",
    "Go to line": "Перейти к строке",
    go: "перейти",
    "Fold line": "Свернуть строку",
    "Unfold line": "Развернуть строку",
    "folded code": "свёрнутый код",
    unfold: "развернуть",
  },
  zh: {
    Find: "查找",
    Replace: "替换",
    next: "下一个",
    previous: "上一个",
    all: "全部",
    "match case": "区分大小写",
    "by word": "全字匹配",
    regexp: "正则表达式",
    replace: "替换",
    "replace all": "全部替换",
    close: "关闭",
    "current match": "当前匹配",
    "replaced $ matches": "已替换 $ 处匹配",
    "replaced match on line $": "已替换第 $ 行的匹配",
    "on line": "行",
    "Go to line": "转到行",
    go: "转到",
    "Fold line": "折叠行",
    "Unfold line": "展开行",
    "folded code": "已折叠的代码",
    unfold: "展开",
  },
};

/** CodeMirror's texts for a language (English is CodeMirror's own). */
export function editorPhrases(locale: string): Extension {
  return EditorState.phrases.of(PHRASES[locale.slice(0, 2)] ?? {});
}

export interface EditorSetup {
  /** Line numbers and folding (off for prose). */
  gutters?: boolean;
  /** Long lines wrap instead of scrolling. */
  wrap?: boolean;
  /** Tab indents (Escape, then Tab, leaves the editor). */
  tabIndents?: boolean;
  autocomplete?: boolean;
  placeholder?: string;
}

/** The common editing features: history, search and replace, selection, brackets, highlighting. */
export function editorSetup(options: EditorSetup = {}): Extension {
  return [
    options.gutters !== false
      ? [lineNumbers(), highlightActiveLineGutter(), foldGutter(), keymap.of(foldKeymap)]
      : [],
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(everyosHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    options.autocomplete ? autocompletion() : [],
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    options.wrap ? EditorView.lineWrapping : [],
    options.placeholder ? placeholderText(options.placeholder) : [],
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...(options.autocomplete ? completionKeymap : []),
      ...(options.tabIndents ? [indentWithTab] : []),
    ]),
    everyosEditorTheme,
  ];
}

/** Languages CodeMirror knows (for a language menu): name and file extensions. */
export const EDITOR_LANGUAGES: ReadonlyArray<{ name: string; extensions: readonly string[] }> =
  languages.map((language) => ({ name: language.name, extensions: language.extensions }));

/** Matches a file name as written, then lowercased (`MAIN.C`, `Styles.CSS`). */
function byFilename(fileName: string): LanguageDescription | null {
  return (
    LanguageDescription.matchFilename(languages, fileName) ??
    LanguageDescription.matchFilename(languages, fileName.toLowerCase())
  );
}

/** The language CodeMirror would use for a file name (extension or whole name), or null. */
export function languageNameFor(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  return byFilename(fileName)?.name ?? null;
}

/** Loads the language for a file name or a language name (null: plain text). */
export async function loadLanguage(
  nameOrFile: string | null | undefined,
): Promise<LanguageSupport | null> {
  if (!nameOrFile) return null;
  const description =
    LanguageDescription.matchLanguageName(languages, nameOrFile, true) ?? byFilename(nameOrFile);
  return description ? description.load() : null;
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** A language (or none); changing it reconfigures the editor without losing the text. */
  language?: Extension | null;
  readOnly?: boolean;
  setup?: EditorSetup;
  /** More extensions (fixed for the editor's life). */
  extensions?: Extension;
  label: string;
  className?: string;
  /** The view, once created (for commands such as `openSearchPanel`). */
  onView?: (view: EditorView | null) => void;
}

/**
 * A CodeMirror editor as a React component. `value` is the source of truth: typing calls
 * `onChange`, and a new `value` from outside replaces the text (keeping the selection in range).
 */
export function CodeEditor({
  value,
  onChange,
  language = null,
  readOnly = false,
  setup,
  extensions = [],
  label,
  className,
  onView,
}: CodeEditorProps) {
  const i18n = useI18n();
  // A new function per language: the effect below follows language changes.
  const t = useT();
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const compartments = useRef({
    language: new Compartment(),
    readOnly: new Compartment(),
    phrases: new Compartment(),
  });
  const latest = useRef({ onChange, onView });
  useEffect(() => {
    latest.current = { onChange, onView };
  });

  useEffect(() => {
    const { language: lang, readOnly: ro, phrases } = compartments.current;
    const created = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          editorSetup(setup),
          lang.of(language ?? []),
          ro.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          phrases.of(editorPhrases(i18n.locale)),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) => transaction.annotation(fromOutside))
            )
              latest.current.onChange?.(update.state.doc.toString());
          }),
          extensions,
        ],
      }),
    });
    view.current = created;
    latest.current.onView?.(created);
    return () => {
      latest.current.onView?.(null);
      created.destroy();
      view.current = null;
    };
    // The editor is created once; the effects below keep it in step.
  }, []);

  useEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === value) return;
    const head = Math.min(current.state.selection.main.head, value.length);
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: value },
      selection: { anchor: head },
      annotations: [fromOutside.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.language.reconfigure(language ?? []),
    });
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.readOnly.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.phrases.reconfigure(editorPhrases(i18n.locale)),
    });
  }, [i18n, t]);

  return <div ref={parent} className={["eui-code-editor", className].filter(Boolean).join(" ")} />;
}

export { EditorView, EditorState, type Extension };
