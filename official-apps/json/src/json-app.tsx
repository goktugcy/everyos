import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  errorMessage,
  IconButton,
  LoadingState,
  saveTextFile,
  Select,
  Spacer,
  Switch,
  Tabs,
  Toolbar,
  ToolbarTitle,
  formatBytes,
  openTextFile,
  useApp,
  useDebounced,
  useI18n,
  useNarrow,
  usePersistentState,
  useShortcuts,
  useT,
  useToast,
} from "@everyos/app-ui";
import { CodeEditor, EditorView } from "@everyos/app-ui/editor";
import { json } from "@codemirror/lang-json";
import { linter, type Diagnostic } from "@codemirror/lint";
import { AlignLeft, Copy, FileDown, FolderOpen, Minimize2, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diffJson, type Difference } from "./diff.ts";
import {
  formatJson,
  isTabular,
  minifyJson,
  parseJson,
  pathString,
  toCsv,
  type Indent,
  type Json,
  type ParseResult,
  type PathSegment,
} from "./json.ts";
import { JsonPathError, query, type Match } from "./jsonpath.ts";
import { TreeView } from "./tree.tsx";

type Panel = "tree" | "query" | "diff" | "csv";

interface Settings {
  indent: Indent;
  sortKeys: boolean;
  panel: Panel;
}

interface Draft {
  text: string;
  name: string;
}

const DRAFT_LIMIT = 200_000;
const MAX_BYTES = 16 * 1024 * 1024;
const jsonLanguage = json();
const EXAMPLES = ["$..*", "$.*", "$[0]", "$..name", "$[?(@.price < 10)]", "$.items.length"];

export function JsonApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const narrow = useNarrow(820);
  const [settings, setSettings] = usePersistentState<Settings>("settings", {
    indent: 2,
    sortKeys: false,
    panel: "tree",
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reveal, setReveal] = useState<PathSegment[] | null>(null);
  const view = useRef<EditorView | null>(null);
  const fail = useCallback(
    (caught: unknown) => toast(errorMessage(t, caught), "danger"),
    [t, toast],
  );

  useEffect(() => {
    void app.storage
      .get<Draft>("draft")
      .then((stored) =>
        setDraft(
          stored && typeof stored.text === "string" ? stored : { text: "", name: "data.json" },
        ),
      )
      .catch(() => setDraft({ text: "", name: "data.json" }));
  }, [app]);

  useEffect(() => {
    if (!draft || draft.text.length > DRAFT_LIMIT) return;
    const timer = setTimeout(
      () => void app.storage.set("draft", draft).catch(() => undefined),
      500,
    );
    return () => clearTimeout(timer);
  }, [app, draft]);

  const text = useDebounced(draft?.text ?? "", 250);
  const parsed: ParseResult | null = useMemo(() => (text.trim() ? parseJson(text) : null), [text]);
  const value = parsed?.ok ? parsed.value : null;

  // Problems underlined in the editor, from the same parser.
  const lint = useMemo(
    () =>
      linter(
        (editor): Diagnostic[] => {
          const source = editor.state.doc.toString();
          if (!source.trim()) return [];
          const result = parseJson(source);
          if (result.ok) return [];
          const from = Math.min(result.error.offset, source.length);
          return [
            {
              from,
              to: Math.min(source.length, from + 1),
              severity: "error",
              message: t(`problems.${result.error.problem}`),
            },
          ];
        },
        { delay: 300 },
      ),
    [t],
  );

  const setText = (next: string) =>
    setDraft((current) => (current ? { ...current, text: next } : current));

  const reformat = (minify: boolean) => {
    if (!draft) return;
    const result = parseJson(draft.text);
    if (!result.ok) return toast(t("status.fixFirst"), "danger");
    setText(
      minify
        ? minifyJson(result.value)
        : formatJson(result.value, settings.indent, settings.sortKeys),
    );
  };

  const open = async () => {
    try {
      const file = await openTextFile(app, {
        accept: [".json", ".geojson", ".jsonl", ".txt"],
        maxBytes: MAX_BYTES,
      });
      if (file) setDraft({ text: file.text, name: file.name });
    } catch (caught) {
      fail(caught);
    }
  };
  const save = async () => {
    if (!draft) return;
    try {
      if (await saveTextFile(app, draft.name, draft.text, { accept: [".json"] }))
        toast(t("ui.exported"));
    } catch (caught) {
      fail(caught);
    }
  };
  const copy = async (content: string) => {
    try {
      await app.clipboard.writeText(content);
      toast(t("ui.copied"));
    } catch (caught) {
      fail(caught);
    }
  };

  const goToError = () => {
    if (!parsed || parsed.ok || !view.current) return;
    const at = Math.min(parsed.error.offset, view.current.state.doc.length);
    view.current.dispatch({
      selection: { anchor: at },
      effects: EditorView.scrollIntoView(at, { y: "center" }),
    });
    view.current.focus();
  };

  useShortcuts({
    "mod+o": () => void open(),
    "mod+s": () => void save(),
    "mod+shift+f": () => reformat(false),
  });

  if (!draft) return <LoadingState />;

  const bytes = new TextEncoder().encode(draft.text).length;
  const panel = (
    <section className="json-panel" aria-label={t(`panels.${settings.panel}`)}>
      <Tabs<Panel>
        label={t("panels.label")}
        value={settings.panel}
        onChange={(next) => setSettings((current) => ({ ...current, panel: next }))}
        tabs={(["tree", "query", "diff", "csv"] as const).map((entry) => ({
          value: entry,
          label: t(`panels.${entry}`),
        }))}
      />
      <div className="json-panel-body">
        {value === null ? (
          <EmptyState title={parsed ? t("status.invalidPanel") : t("status.emptyPanel")} />
        ) : settings.panel === "tree" ? (
          <TreeView value={value} reveal={reveal} />
        ) : settings.panel === "query" ? (
          <QueryPanel
            value={value}
            onShow={(path) => {
              setReveal(path);
              setSettings((current) => ({ ...current, panel: "tree" }));
            }}
            onCopy={(content) => void copy(content)}
          />
        ) : settings.panel === "diff" ? (
          <DiffPanel value={value} />
        ) : (
          <CsvPanel value={value} name={draft.name} onCopy={(content) => void copy(content)} />
        )}
      </div>
    </section>
  );

  return (
    <div className="json-app">
      <Toolbar label={t("app.name")}>
        <ToolbarTitle>{draft.name}</ToolbarTitle>
        <Spacer />
        <IconButton
          label={t("actions.open")}
          icon={<FolderOpen size={16} aria-hidden />}
          onClick={() => void open()}
        />
        <IconButton
          label={t("actions.save")}
          icon={<Save size={16} aria-hidden />}
          onClick={() => void save()}
        />
        <Select<string>
          label={t("actions.indent")}
          hideLabel
          value={String(settings.indent)}
          onChange={(indent) =>
            setSettings((current) => ({
              ...current,
              indent: indent === "tab" ? "tab" : (Number(indent) as 2 | 4),
            }))
          }
          options={[
            { value: "2", label: t("indent.two") },
            { value: "4", label: t("indent.four") },
            { value: "tab", label: t("indent.tab") },
          ]}
        />
        <label className="json-switch">
          <Switch
            label={t("actions.sortKeys")}
            checked={settings.sortKeys}
            onChange={(sortKeys) => setSettings((current) => ({ ...current, sortKeys }))}
          />
          <span aria-hidden>{t("actions.sortKeys")}</span>
        </label>
        <Button
          size="sm"
          icon={<AlignLeft size={14} aria-hidden />}
          onClick={() => reformat(false)}
        >
          {t("actions.format")}
        </Button>
        <Button size="sm" icon={<Minimize2 size={14} aria-hidden />} onClick={() => reformat(true)}>
          {t("actions.minify")}
        </Button>
        <IconButton
          label={t("actions.copy")}
          icon={<Copy size={16} aria-hidden />}
          onClick={() => void copy(draft.text)}
        />
      </Toolbar>
      <div className="json-body" data-narrow={narrow || undefined}>
        <div className="json-editor-pane">
          <div className="json-editor">
            <CodeEditor
              value={draft.text}
              language={jsonLanguage}
              label={t("editor.label")}
              setup={{ tabIndents: true, placeholder: t("editor.placeholder") }}
              extensions={lint}
              onChange={setText}
              onView={(editor) => {
                view.current = editor;
              }}
            />
          </div>
          <div className="json-status" role="status">
            {!parsed ? (
              <span>{t("status.empty")}</span>
            ) : parsed.ok ? (
              <>
                <Badge tone="success">{t("status.valid")}</Badge>
                <span>{formatBytes(bytes, i18n.tag)}</span>
              </>
            ) : (
              <>
                <Badge tone="danger">{t("status.invalid")}</Badge>
                <button type="button" className="json-error" onClick={goToError}>
                  {t("status.at", { line: parsed.error.line, column: parsed.error.column })}:{" "}
                  {t(`problems.${parsed.error.problem}`)}
                </button>
              </>
            )}
          </div>
        </div>
        {panel}
      </div>
    </div>
  );
}

function preview(value: Json): string {
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function QueryPanel({
  value,
  onShow,
  onCopy,
}: {
  value: Json;
  onShow: (path: PathSegment[]) => void;
  onCopy: (text: string) => void;
}) {
  const t = useT();
  const [source, setSource] = usePersistentState("query", "$..*");
  const settled = useDebounced(source, 200);
  const result = useMemo((): { matches: Match[] } | { error: JsonPathError } => {
    try {
      return { matches: query(value, settled) };
    } catch (error) {
      if (error instanceof JsonPathError) return { error };
      throw error;
    }
  }, [value, settled]);
  return (
    <div className="json-query">
      <label className="eui-field">
        <span className="eui-label">{t("query.label")}</span>
        <input
          className="eui-input eui-mono"
          value={source}
          spellCheck={false}
          aria-invalid={"error" in result || undefined}
          onChange={(event) => setSource(event.target.value)}
        />
      </label>
      <div className="json-chips" role="group" aria-label={t("query.examples")}>
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className="json-chip"
            onClick={() => setSource(example)}
          >
            {example}
          </button>
        ))}
      </div>
      {"error" in result ? (
        <p className="eui-error-text" role="alert">
          {t("query.error", { position: result.error.position + 1, message: result.error.message })}
        </p>
      ) : (
        <>
          <div className="json-query-head">
            <span>{t("query.results", { count: result.matches.length })}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={!result.matches.length}
              onClick={() =>
                onCopy(
                  JSON.stringify(
                    result.matches.map((match) => match.value),
                    null,
                    2,
                  ),
                )
              }
            >
              {t("query.copy")}
            </Button>
          </div>
          <ul className="json-results">
            {result.matches.slice(0, 500).map((match) => (
              <li key={pathString(match.path)}>
                <button type="button" onClick={() => onShow(match.path)} title={t("query.show")}>
                  <code>{pathString(match.path)}</code>
                  <span>{preview(match.value)}</span>
                </button>
              </li>
            ))}
          </ul>
          {result.matches.length > 500 ? (
            <p className="eui-hint">{t("query.more", { count: result.matches.length - 500 })}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function DiffPanel({ value }: { value: Json }) {
  const app = useApp();
  const t = useT();
  const toast = useToast();
  const [other, setOther] = usePersistentState("compare", "");
  const settled = useDebounced(other, 250);
  const parsed = useMemo(() => (settled.trim() ? parseJson(settled) : null), [settled]);
  const differences: Difference[] = useMemo(
    () => (parsed?.ok ? diffJson(value, parsed.value) : []),
    [value, parsed],
  );
  const counts = {
    added: differences.filter((entry) => entry.kind === "added").length,
    removed: differences.filter((entry) => entry.kind === "removed").length,
    changed: differences.filter((entry) => entry.kind === "changed").length,
  };
  return (
    <div className="json-diff">
      <div className="json-diff-head">
        <span>{t("diff.with")}</span>
        <Button
          size="sm"
          icon={<FolderOpen size={14} aria-hidden />}
          onClick={async () => {
            try {
              const file = await openTextFile(app, { accept: [".json"], maxBytes: MAX_BYTES });
              if (file) setOther(file.text);
            } catch (caught) {
              toast(errorMessage(t, caught), "danger");
            }
          }}
        >
          {t("diff.open")}
        </Button>
      </div>
      <textarea
        className="eui-textarea eui-mono json-diff-input"
        aria-label={t("diff.other")}
        placeholder={t("diff.placeholder")}
        value={other}
        spellCheck={false}
        onChange={(event) => setOther(event.target.value)}
      />
      {parsed && !parsed.ok ? (
        <p className="eui-error-text" role="alert">
          {t("status.at", { line: parsed.error.line, column: parsed.error.column })}:{" "}
          {t(`problems.${parsed.error.problem}`)}
        </p>
      ) : parsed?.ok ? (
        differences.length ? (
          <>
            <p className="json-diff-summary">
              <Badge tone="success">{t("diff.added", { count: counts.added })}</Badge>{" "}
              <Badge tone="danger">{t("diff.removed", { count: counts.removed })}</Badge>{" "}
              <Badge tone="warning">{t("diff.changed", { count: counts.changed })}</Badge>
            </p>
            <ul className="json-differences">
              {differences.slice(0, 1000).map((entry) => (
                <li key={`${entry.kind}:${pathString(entry.path)}`} data-kind={entry.kind}>
                  <code>{pathString(entry.path)}</code>
                  {entry.kind !== "added" ? (
                    <span className="json-before">{preview(entry.before ?? null)}</span>
                  ) : null}
                  {entry.kind !== "removed" ? (
                    <span className="json-after">{preview(entry.after ?? null)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <EmptyState title={t("diff.same")} />
        )
      ) : null}
    </div>
  );
}

function CsvPanel({
  value,
  name,
  onCopy,
}: {
  value: Json;
  name: string;
  onCopy: (text: string) => void;
}) {
  const app = useApp();
  const t = useT();
  const toast = useToast();
  const table = useMemo(() => (isTabular(value) ? toCsv(value) : null), [value]);
  if (!table) return <EmptyState title={t("csv.needsArray")} text={t("csv.needsArrayText")} />;
  const base = name.replace(/\.[^.]+$/, "") || "data";
  return (
    <div className="json-csv">
      <div className="json-diff-head">
        <span>
          {t("csv.summary", { rows: table.records.length, columns: table.columns.length })}
        </span>
        <Spacer />
        <Button size="sm" variant="ghost" onClick={() => onCopy(table.csv)}>
          {t("csv.copy")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<FileDown size={14} aria-hidden />}
          onClick={async () => {
            try {
              if (await saveTextFile(app, `${base}.csv`, table.csv, { accept: [".csv"] }))
                toast(t("ui.exported"));
            } catch (caught) {
              toast(errorMessage(t, caught), "danger");
            }
          }}
        >
          {t("csv.export")}
        </Button>
      </div>
      <div className="json-csv-table">
        <DataTable
          label={t("csv.preview")}
          rows={table.records.slice(0, 200).map((record, index) => ({ record, index }))}
          getKey={(row) => String(row.index)}
          columns={table.columns.slice(0, 30).map((column) => ({
            key: column,
            label: column,
            render: (row: { record: Record<string, Json> }) => {
              const cell = row.record[column];
              return cell === undefined
                ? ""
                : typeof cell === "string"
                  ? cell
                  : JSON.stringify(cell);
            },
          }))}
        />
      </div>
    </div>
  );
}
