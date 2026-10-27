import { isBridgeError } from "@everyos/app-sdk";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  LoadingState,
  SearchInput,
  Select,
  Shell,
  Spacer,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  saveTextFile,
  useApp,
  useAsync,
  useI18n,
  usePersistentState,
  useT,
} from "@everyos/app-ui";
import { useEffect, useState } from "react";
import {
  DEFAULT_FILTERS,
  bindScope,
  filterListeners,
  listenersCsv,
  readFilters,
  type Filters,
} from "./ports.ts";

export function PortsApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const [stored, saveFilters, filterState] = usePersistentState<unknown>(
    "filters",
    DEFAULT_FILTERS,
  );
  const filters = readFilters(stored);
  const [allowed, setAllowed] = useState(() => app.permissions.has("system:sockets.read"));
  const [saveAllowed, setSaveAllowed] = useState(() => app.permissions.has("files:save"));
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);
  const [page, setPage] = useState(0);
  const data = useAsync(async () => {
    if (!allowed) return null;
    const sockets = await app.host.call("system.sockets", null);
    return { sockets, at: Date.now() };
  }, [app, allowed]);
  useEffect(
    () =>
      app.permissions.onChange((granted) => {
        setAllowed(granted.has("system:sockets.read"));
        setSaveAllowed(granted.has("files:save"));
        setExportError(null);
      }),
    [app],
  );
  const snapshot = allowed ? data.data : null;
  const rows = filterListeners(snapshot?.sockets.listening ?? [], filters).map((row, index) => ({
    ...row,
    key: String(index),
  }));
  const pages = Math.max(1, Math.ceil(rows.length / 100));
  const currentPage = Math.min(page, pages - 1);
  const change = (next: Partial<Filters>) => {
    saveFilters({ ...filters, ...next });
    setPage(0);
  };
  const unsupported =
    isBridgeError(data.error) && data.error.code === "HOST_CAPABILITY_UNAVAILABLE";
  const loadError = !data.error
    ? null
    : unsupported
      ? t("ports.unavailable")
      : isBridgeError(data.error) &&
          ["FORBIDDEN", "EVERYOS_PERMISSION_DENIED", "AGENT_OPERATION_DENIED"].includes(
            data.error.code,
          )
        ? t("ports.permission")
        : t("ports.loadFailed");
  const exportRows = async () => {
    if (!snapshot || exporting || !saveAllowed) return;
    setExporting(true);
    setExportError(null);
    try {
      await saveTextFile(
        app,
        "listening-ports.csv",
        listenersCsv(snapshot.sockets.source, snapshot.at, rows),
        { accept: [".csv"] },
      );
    } catch (error) {
      setExportError(error);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Shell
      toolbar={() => (
        <Toolbar>
          <ToolbarTitle>{t("app.name")}</ToolbarTitle>
          <Spacer />
          <Button onClick={data.reload} disabled={!allowed || data.loading}>
            {t("ports.refresh")}
          </Button>
          <Button
            onClick={() => void exportRows()}
            disabled={!snapshot || data.loading || exporting || !saveAllowed || !rows.length}
          >
            {t("ports.export")}
          </Button>
        </Toolbar>
      )}
    >
      <div className="ports-main">
        <p className="ports-hint">{t("ports.readOnly")}</p>
        {!allowed ? (
          <p role="alert" className="eui-error-text">
            {t("ports.permission")}
          </p>
        ) : null}
        {allowed && loadError ? (
          <p role="alert" className="eui-error-text">
            {loadError}
          </p>
        ) : null}
        {filterState.error || exportError ? (
          <p role="alert" className="eui-error-text">
            {errorMessage(t, exportError ?? filterState.error)}
          </p>
        ) : null}
        {data.loading ? <LoadingState /> : null}
        {snapshot ? (
          <>
            <div className="ports-source">
              <Badge tone={snapshot.sockets.source === "simulated" ? "warning" : "neutral"}>
                {t(`ports.${snapshot.sockets.source}`)}
              </Badge>
              <span>
                {t("ports.retrieved", {
                  at: i18n.date(snapshot.at, { dateStyle: "short", timeStyle: "medium" }),
                })}
              </span>
            </div>
            {snapshot.sockets.source === "simulated" ? (
              <p role="status">{t("ports.simulatedHint")}</p>
            ) : null}
            {data.error ? <p className="ports-warning">{t("ports.stale")}</p> : null}
            <dl className="ports-stats">
              <div>
                <dt>{t("ports.listening")}</dt>
                <dd>{i18n.number(snapshot.sockets.listening.length)}</dd>
              </div>
              <div>
                <dt>{t("ports.established")}</dt>
                <dd>{i18n.number(snapshot.sockets.connections.established)}</dd>
              </div>
              <div>
                <dt>{t("ports.timeWait")}</dt>
                <dd>{i18n.number(snapshot.sockets.connections.timeWait)}</dd>
              </div>
              <div>
                <dt>{t("ports.other")}</dt>
                <dd>{i18n.number(snapshot.sockets.connections.other)}</dd>
              </div>
            </dl>
          </>
        ) : null}
        {filterState.loaded ? (
          <div className="ports-filters">
            <SearchInput
              value={filters.query}
              onChange={(query) => change({ query: query.slice(0, 200) })}
              label={t("ports.search")}
              placeholder={t("ports.searchHint")}
            />
            <Select
              label={t("ports.protocol")}
              value={filters.protocol}
              onChange={(protocol) => change({ protocol })}
              options={[
                { value: "all", label: t("ports.all") },
                { value: "tcp", label: "TCP" },
                { value: "udp", label: "UDP" },
              ]}
            />
            <Select
              label={t("ports.family")}
              value={filters.family}
              onChange={(family) => change({ family })}
              options={[
                { value: "all", label: t("ports.all") },
                { value: "ipv4", label: "IPv4" },
                { value: "ipv6", label: "IPv6" },
              ]}
            />
            <Select
              label={t("ports.scope")}
              value={filters.scope}
              onChange={(scope) => change({ scope })}
              options={["all", "wildcard", "loopback", "specific"].map((value) => ({
                value: value as Filters["scope"],
                label: t(`scope.${value}`),
              }))}
            />
            <Button
              onClick={() => {
                saveFilters(DEFAULT_FILTERS);
                setPage(0);
              }}
            >
              {t("ports.reset")}
            </Button>
          </div>
        ) : null}
        {snapshot ? (
          <>
            <p className="ports-hint">
              {t("ports.showing", { shown: rows.length, total: snapshot.sockets.listening.length })}
            </p>
            <p className="ports-hint">{t("ports.limit")}</p>
            {rows.length === 0 ? (
              <EmptyState title={t("ports.empty")} text={t("ports.emptyHint")} />
            ) : null}
            <div className="ports-table">
              <DataTable
                label={t("ports.listening")}
                rows={rows.slice(currentPage * 100, currentPage * 100 + 100)}
                getKey={(row) => row.key}
                columns={[
                  {
                    key: "protocol",
                    label: t("ports.protocol"),
                    render: (row) => row.protocol.toUpperCase(),
                  },
                  {
                    key: "address",
                    label: t("ports.address"),
                    render: (row) => <code>{row.address}</code>,
                  },
                  { key: "port", label: t("ports.port"), render: (row) => row.port },
                  {
                    key: "scope",
                    label: t("ports.scope"),
                    render: (row) => t(`scope.${bindScope(row.address)}`),
                  },
                  {
                    key: "process",
                    label: t("ports.process"),
                    render: (row) => row.process ?? t("ports.unknown"),
                  },
                ]}
              />
            </div>
            <p className="ports-hint">{t("ports.processHint")}</p>
            {pages > 1 ? (
              <div className="ports-pagination">
                <Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                  {t("ports.previous")}
                </Button>
                <span>{t("ports.page", { page: currentPage + 1, pages })}</span>
                <Button
                  disabled={currentPage >= pages - 1}
                  onClick={() => setPage(currentPage + 1)}
                >
                  {t("ports.next")}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Shell>
  );
}
