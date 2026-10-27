import { isBridgeError, type DbQueryResult, type DbTable } from "@everyos/app-sdk";
import { sql as sqlLanguage, MySQL, PostgreSQL } from "@codemirror/lang-sql";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  LoadingState,
  SearchInput,
  Select,
  Shell,
  Spacer,
  TextArea,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  useApp,
  useAsync,
  useI18n,
  usePersistentState,
  useShortcuts,
  useT,
} from "@everyos/app-ui";
import { CodeEditor } from "@everyos/app-ui/editor";
import { useEffect, useMemo, useRef, useState } from "react";
import { cellText, csv, parameters, preferences, selectTable } from "./query.ts";

interface History {
  connection: string;
  name: string;
  sql: string;
  at: number;
  rows: number | null;
  ms: number;
  write: boolean;
}
interface Result {
  data: DbQueryResult;
  name: string;
  sql: string;
}
export function SqlApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const [raw, setPreferences, persisted] = usePersistentState<unknown>("preferences.v1", null);
  const prefs = preferences(raw);
  const [allowed, setAllowed] = useState(app.permissions.has("database:connect"));
  const [saveAllowed, setSaveAllowed] = useState(app.permissions.has("files:save"));
  const connections = useAsync(
    async () => (allowed ? (await app.host.call("db.connections", null)).connections : []),
    [app, allowed],
  );
  const connection = allowed
    ? (connections.data?.find((item) => item.id === prefs.connection) ??
      connections.data?.[0] ??
      null)
    : null;
  const tables = useAsync(
    async () => ({
      connection: connection?.id ?? null,
      ...(connection
        ? await app.host.call("db.tables", { connection: connection.id })
        : { tables: [], truncated: false }),
    }),
    [app, connection?.id, allowed],
  );
  const [source, setSource] = useState("");
  const [params, setParams] = useState("[]");
  const [write, setWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  const [version, setVersion] = useState<{ version: string; ms: number } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [search, setSearch] = useState("");
  const [tablePage, setTablePage] = useState(0);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<DbTable | null>(null);
  const active = useRef(false);
  const generation = useRef(0);
  const dialect = useMemo(
    () => sqlLanguage({ dialect: connection?.engine === "mysql" ? MySQL : PostgreSQL }),
    [connection?.engine],
  );
  const update = (patch: Partial<typeof prefs>) => setPreferences({ ...prefs, ...patch });
  useEffect(() => {
    generation.current++;
    active.current = false;
    setBusy(false);
    setWrite(false);
    setResult(null);
    setVersion(null);
    setSelected(null);
    setError(null);
    setTablePage(0);
  }, [connection?.id, connection?.access, allowed]);
  useEffect(() => {
    const invalidate = () => {
      generation.current++;
      active.current = false;
      setBusy(false);
      setWrite(false);
    };
    const permissions = app.permissions.onChange(() => {
      const granted = app.permissions.has("database:connect");
      setAllowed(granted);
      setSaveAllowed(app.permissions.has("files:save"));
      invalidate();
      if (!granted) {
        setSource("");
        setParams("[]");
        setHistory([]);
        setResult(null);
        setSelected(null);
        setVersion(null);
      }
    });
    const suspend = app.lifecycle.onSuspend(invalidate);
    window.addEventListener("pagehide", invalidate);
    return () => {
      permissions();
      suspend();
      window.removeEventListener("pagehide", invalidate);
      generation.current++;
    };
  }, [app]);
  const message = (cause: unknown) => {
    if (isBridgeError(cause)) {
      if (cause.code === "DESKTOP_APP_DB_READ_ONLY") return t("sql.readOnlyError");
      if (cause.code === "RATE_LIMITED") return t("sql.busyError");
      if (cause.code === "FORBIDDEN") return t("sql.permission");
      if (cause.code === "DESKTOP_APP_DB_FAILED") {
        const details = cause.details as {
          code?: unknown;
          message?: unknown;
          position?: unknown;
        } | null;
        return t("sql.failed", {
          code: typeof details?.code === "string" ? details.code : "",
          message: typeof details?.message === "string" ? details.message.slice(0, 2000) : "",
          position: typeof details?.position === "number" ? details.position : "",
        });
      }
    }
    return errorMessage(t, cause);
  };
  const perform = async (work: (epoch: number) => Promise<void>) => {
    if (active.current || !app.permissions.has("database:connect")) return;
    const epoch = generation.current;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      await work(epoch);
    } catch (cause) {
      if (epoch === generation.current && message(cause)) setError(cause);
    } finally {
      if (epoch === generation.current) {
        active.current = false;
        setBusy(false);
      }
    }
  };
  const run = () => {
    if (!connection || !source.trim() || source.length > 100000) {
      setInvalid(true);
      return;
    }
    const values = parameters(params);
    if (!values) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const query = source;
    const target = connection;
    void perform(async (epoch) => {
      const data = await app.host.call("db.query", {
        connection: target.id,
        sql: query,
        params: values,
        maxRows: prefs.maxRows,
        timeoutMs: prefs.timeoutMs,
        write: write && target.access === "write",
      });
      if (epoch !== generation.current) return;
      setResult({ data, name: target.name, sql: query });
      setPage(0);
      setHistory((items) =>
        [
          {
            connection: target.id,
            name: target.name,
            sql: query,
            at: Date.now(),
            rows: data.rowCount,
            ms: data.ms,
            write: !data.readOnly,
          },
          ...items,
        ].slice(0, 30),
      );
    });
  };
  useShortcuts({ "mod+enter": run });
  const schema =
    allowed && connection && tables.data?.connection === connection.id ? tables.data.tables : [];
  const shown = schema.filter((table) =>
    `${table.schema ?? ""}.${table.name}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const tablePages = Math.max(1, Math.ceil(shown.length / 100));
  const results = result?.data;
  const pages = Math.max(1, Math.ceil((results?.rows.length ?? 0) / 100));
  const exportResults = () => {
    if (!result) return;
    const snapshot = result;
    void perform(async (epoch) => {
      const file = await app.files.save({ suggestedName: "query-results.csv", accept: [".csv"] });
      if (!file || epoch !== generation.current || !app.permissions.has("files:save")) return;
      await app.files.write(file, csv(snapshot.data));
    });
  };
  return (
    <Shell
      toolbar={() => (
        <Toolbar>
          <ToolbarTitle>{t("app.name")}</ToolbarTitle>
          <Spacer />
          <Button
            disabled={busy || connections.loading || !allowed}
            onClick={() => {
              connections.reload();
              tables.reload();
            }}
          >
            {t("sql.refresh")}
          </Button>
          <Button
            disabled={busy || !connection || tables.loading}
            onClick={() =>
              void perform(async (epoch) => {
                const answer = await app.host.call("db.test", { connection: connection!.id });
                if (epoch === generation.current) setVersion(answer);
              })
            }
          >
            {t("sql.test")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !connection || tables.loading || !persisted.loaded}
            onClick={run}
          >
            {t(busy ? "sql.running" : "sql.run")}
          </Button>
        </Toolbar>
      )}
    >
      <div className="sql-main">
        <p className="sql-hint">{t("sql.scope")}</p>
        {!allowed ? <p role="status">{t("sql.permission")}</p> : null}
        {connections.loading || !persisted.loaded ? <LoadingState /> : null}
        {connections.error ? <p role="alert">{message(connections.error)}</p> : null}
        {persisted.error ? <p role="alert">{errorMessage(t, persisted.error)}</p> : null}
        {allowed && !connections.loading && !connections.data?.length ? (
          <EmptyState title={t("sql.noConnections")} text={t("sql.scope")} />
        ) : null}
        <div className="sql-settings">
          <Select
            label={t("sql.connection")}
            value={connection?.id ?? ""}
            options={(allowed ? (connections.data ?? []) : []).map((item) => ({
              value: item.id,
              label: `${item.name} · ${item.engine}`,
            }))}
            disabled={busy || !allowed}
            onChange={(id) => update({ connection: id })}
          />
          <Select
            label={t("sql.maxRows")}
            value={String(prefs.maxRows)}
            options={[100, 500, 1000].map((n) => ({ value: String(n), label: i18n.number(n) }))}
            onChange={(value) => update({ maxRows: Number(value) })}
          />
          <Select
            label={t("sql.timeout")}
            value={String(prefs.timeoutMs)}
            options={[1000, 5000, 30000, 60000, 120000].map((n) => ({
              value: String(n),
              label: t("sql.seconds", { value: i18n.number(n / 1000) }),
            }))}
            onChange={(value) => update({ timeoutMs: Number(value) })}
          />
        </div>
        {connection ? (
          <p>
            {connection.database} · {connection.host}:
            {i18n.number(connection.port, { useGrouping: false })}{" "}
            <Badge>{t(connection.access === "write" ? "sql.writable" : "sql.readOnly")}</Badge>
          </p>
        ) : null}
        {version ? (
          <p role="status">
            {t("sql.tested", { version: version.version, ms: i18n.number(version.ms) })}
          </p>
        ) : null}
        <div className="sql-workspace">
          <section className="sql-schema">
            <h2>{t("sql.tables")}</h2>
            <SearchInput
              label={t("sql.findTable")}
              value={search}
              onChange={(value) => {
                setSearch(value);
                setTablePage(0);
              }}
            />
            {tables.loading ? <LoadingState /> : null}
            {tables.error ? <p role="alert">{message(tables.error)}</p> : null}
            {tables.data?.truncated ? <p role="status">{t("sql.schemaTruncated")}</p> : null}
            <div className="sql-table-list">
              {shown
                .slice(
                  Math.min(tablePage, tablePages - 1) * 100,
                  (Math.min(tablePage, tablePages - 1) + 1) * 100,
                )
                .map((table) => (
                  <Button
                    key={`${table.schema}.${table.name}`}
                    disabled={busy}
                    onClick={() => {
                      setSelected(table);
                      setSource(selectTable(table, connection!.engine));
                      setParams("[]");
                      setWrite(false);
                    }}
                  >
                    {table.schema ? `${table.schema}.` : ""}
                    {table.name}
                  </Button>
                ))}
            </div>
            {tablePages > 1 ? (
              <div className="sql-paging">
                <Button disabled={tablePage === 0} onClick={() => setTablePage((n) => n - 1)}>
                  {t("sql.previous")}
                </Button>
                <span>
                  {i18n.number(tablePage + 1)}/{i18n.number(tablePages)}
                </span>
                <Button
                  disabled={tablePage >= tablePages - 1}
                  onClick={() => setTablePage((n) => n + 1)}
                >
                  {t("sql.next")}
                </Button>
              </div>
            ) : null}
            {selected ? (
              <dl>
                {selected.columns.map((column) => (
                  <div key={column.name}>
                    <dt>{column.name}</dt>
                    <dd>
                      {column.type}
                      {column.nullable ? " · NULL" : ""}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </section>
          <section className="sql-query">
            <h2>{t("sql.editor")}</h2>
            <div className="sql-editor">
              <CodeEditor
                value={source}
                onChange={setSource}
                language={dialect}
                readOnly={busy || !allowed}
                label={t("sql.editor")}
              />
            </div>
            <TextArea
              label={t("sql.parameters")}
              value={params}
              onChange={(event) => setParams(event.target.value)}
              rows={2}
              disabled={busy || !allowed}
              maxLength={100000}
              mono
            />
            <p className="sql-hint">{t("sql.paramsHint")}</p>
            <Checkbox
              label={t("sql.allowWrite")}
              checked={write}
              disabled={busy || !connection || connection.access !== "write"}
              onChange={setWrite}
            />
            <p className="sql-hint">{t("sql.writeHint")}</p>
            {invalid ? <p role="alert">{t("sql.invalid")}</p> : null}
            {error ? <p role="alert">{message(error)}</p> : null}
          </section>
        </div>
        {result && results ? (
          <section className="sql-results">
            <div className="sql-actions">
              <h2>{t("sql.results")}</h2>
              <Button disabled={busy || !saveAllowed} onClick={exportResults}>
                {t("sql.export")}
              </Button>
            </div>
            <p>
              {result.name} · {results.command ?? ""} ·{" "}
              {t("sql.rows", {
                count: i18n.number(results.rowCount ?? results.rows.length),
                ms: i18n.number(results.ms),
              })}{" "}
              <Badge>{t(results.readOnly ? "sql.readOnly" : "sql.changed")}</Badge>
            </p>
            <details>
              <summary>{t("sql.executed")}</summary>
              <pre>{result.sql}</pre>
            </details>
            {results.truncated ? <p role="status">{t("sql.truncated")}</p> : null}
            <div className="sql-result-scroll">
              <table className="eui-table" aria-label={t("sql.results")}>
                <thead>
                  <tr>
                    {results.columns.map((column, index) => (
                      <th key={index} title={column.type}>
                        {column.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.rows.slice(page * 100, (page + 1) * 100).map((row, index) => (
                    <tr key={index}>
                      {results.columns.map((_, column) => (
                        <td key={column}>{cellText(row[column])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="sql-paging">
              <Button disabled={page === 0} onClick={() => setPage((n) => n - 1)}>
                {t("sql.previous")}
              </Button>
              <span>
                {i18n.number(page + 1)}/{i18n.number(pages)}
              </span>
              <Button disabled={page >= pages - 1} onClick={() => setPage((n) => n + 1)}>
                {t("sql.next")}
              </Button>
            </div>
          </section>
        ) : null}
        <section>
          <div className="sql-actions">
            <h2>{t("sql.history")}</h2>
            <Button
              disabled={!history.length}
              onClick={() =>
                void app.dialogs
                  .confirm(t("sql.clearHistory"), "", { destructive: true })
                  .then((ok) => {
                    if (ok) setHistory([]);
                  })
              }
            >
              {t("sql.clearHistory")}
            </Button>
          </div>
          <p className="sql-hint">{t("sql.historyHint")}</p>
          <div className="sql-history">
            {history.map((item, index) => (
              <Button
                key={index}
                disabled={
                  busy ||
                  !allowed ||
                  !connections.data?.some((entry) => entry.id === item.connection)
                }
                onClick={() => {
                  update({ connection: item.connection });
                  setSource(item.sql);
                  setParams("[]");
                  setWrite(false);
                }}
              >
                {item.name} · {i18n.date(item.at, { timeStyle: "medium" })} · {item.rows ?? ""} ·{" "}
                {item.ms} ms
              </Button>
            ))}
          </div>
        </section>
      </div>
    </Shell>
  );
}
