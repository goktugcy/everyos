import type { NetMonitor, NetMonitorCheck } from "@everyos/app-sdk";
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  ListItem,
  LoadingState,
  Select,
  Shell,
  Spacer,
  TextField,
  Toolbar,
  ToolbarTitle,
  networkMessage,
  saveTextFile,
  useApp,
  useAsync,
  useI18n,
  usePersistentState,
  useT,
} from "@everyos/app-ui";
import { useEffect, useState } from "react";
import {
  EMPTY_DRAFT,
  historyCsv,
  monitorInput,
  parseDraft,
  readDraft,
  toDraft,
  type DraftError,
  type MonitorDraft,
} from "./monitor.ts";

const TONES = {
  pending: "neutral",
  up: "success",
  down: "danger",
  blocked: "warning",
  paused: "neutral",
} as const;
const HISTORY_ERRORS = new Set([
  "status",
  "keyword",
  "blocked",
  "dns",
  "refused",
  "unreachable",
  "timeout",
  "reset",
  "tls",
  "too-many-redirects",
  "invalid-response",
  "error",
]);

export function HttpMonitorApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const [stored, saveDraft, draftState] = usePersistentState<unknown>("draft", null);
  const draft = readDraft(stored);
  const [editing, setEditing] = useState(false);
  const [allowed, setAllowed] = useState(() => app.permissions.has("network:outbound"));
  const [notifyAllowed, setNotifyAllowed] = useState(() =>
    app.permissions.has("notifications:send"),
  );
  const [saveAllowed, setSaveAllowed] = useState(() => app.permissions.has("files:save"));
  const [visible, setVisible] = useState(true);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [range, setRange] = useState("24");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState<DraftError | null>(null);
  const [now, setNow] = useState(Date.now);
  const list = useAsync(
    async () => (allowed ? (await app.host.call("net.monitors.list", null)).monitors : []),
    [app, allowed, revision],
  );
  const monitors = allowed ? (list.data ?? []) : [];
  const selected = monitors.find((m) => m.id === selectedId) ?? monitors[0] ?? null;
  // A scheduled first check can win the race with Check now; show its result promptly.
  const pollMs = selected?.state === "pending" ? 1000 : 30000;
  const history = useAsync(async () => {
    if (!allowed || !selected) return { id: null, range, checks: [] as NetMonitorCheck[] };
    const result = await app.host.call("net.monitors.history", {
      id: selected.id,
      since: Date.now() - Number(range) * 3600000,
      limit: 5000,
    });
    return { id: selected.id, range, checks: result.checks.toSorted((a, b) => b.at - a.at) };
  }, [app, allowed, selected?.id, selected?.checkedAt, range, revision]);
  // useAsync retains previous data while loading; do not display another endpoint's history.
  const checks =
    allowed && history.data?.id === selected?.id && history.data?.range === range
      ? (history.data?.checks ?? [])
      : [];
  const pages = Math.max(1, Math.ceil(checks.length / 100));
  const currentPage = Math.min(page, pages - 1);
  const refresh = () => setRevision((n) => n + 1);

  useEffect(() => {
    const stopPermission = app.permissions.onChange((granted) => {
      setAllowed(granted.has("network:outbound"));
      setNotifyAllowed(granted.has("notifications:send"));
      setSaveAllowed(granted.has("files:save"));
      setError(null);
      setRevision((n) => n + 1);
    });
    const stopSuspend = app.lifecycle.onSuspend(() => setVisible(false));
    const stopResume = app.lifecycle.onResume(() => {
      setVisible(true);
      setRevision((n) => n + 1);
    });
    return () => {
      stopPermission();
      stopSuspend();
      stopResume();
    };
  }, [app]);
  useEffect(() => {
    if (!visible || !allowed || busy || list.loading || history.loading) return;
    const poll = setInterval(() => setRevision((n) => n + 1), pollMs);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [visible, allowed, busy, pollMs, list.loading, history.loading]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
      setNow(Date.now());
    }
  };
  const update = (change: Partial<MonitorDraft>) => {
    if (!draft) return;
    saveDraft({ ...draft, ...change });
    setInvalid(null);
  };
  const closeEditor = () =>
    void run(async () => {
      if (
        !(await app.dialogs.confirm(t("form.discardTitle"), t("form.discardText"), {
          destructive: true,
        }))
      )
        return;
      saveDraft(null);
      setEditing(false);
      setInvalid(null);
    });
  const save = () => {
    if (!draft || !allowed) return;
    const result = parseDraft(draft);
    if ("error" in result) {
      setInvalid(result.error);
      return;
    }
    void run(async () => {
      const saved = await app.host.call("net.monitors.save", result.input);
      setSelectedId(saved.id);
      saveDraft(null);
      setEditing(false);
      refresh();
    });
  };
  const remove = (monitor: NetMonitor) =>
    void run(async () => {
      if (
        !(await app.dialogs.confirm(
          t("monitor.deleteTitle"),
          t("monitor.deleteText", { name: monitor.name }),
          { destructive: true },
        ))
      )
        return;
      await app.host.call("net.monitors.delete", { id: monitor.id });
      setSelectedId(null);
      setPage(0);
      refresh();
    });
  const date = (at: number | null) =>
    at === null ? t("monitor.never") : i18n.date(at, { dateStyle: "short", timeStyle: "medium" });
  const ms = (value: number | null) =>
    value === null
      ? t("monitor.noData")
      : t("monitor.ms", { value: i18n.number(value, { maximumFractionDigits: 1 }) });
  const percent = (value: number | null) =>
    value === null
      ? t("monitor.noData")
      : i18n.number(value, { style: "percent", maximumFractionDigits: 2 });
  const failure = (value: string | null) =>
    value === null
      ? t("history.ok")
      : t(HISTORY_ERRORS.has(value) ? `failure.${value}` : "failure.other");
  const cooldown =
    selected?.checkedAt === null || !selected
      ? 0
      : Math.max(0, Math.ceil((selected.checkedAt + 10000 - now) / 1000));
  const shownError = error ?? list.error ?? history.error ?? draftState.error;
  const field = (
    key: "name" | "url" | "interval" | "timeout" | "min" | "max" | "keyword" | "downAfter",
    type = "text",
    min?: number,
    max?: number,
  ) => (
    <TextField
      label={t(`form.${key}`)}
      value={draft?.[key] ?? ""}
      type={type}
      {...(min === undefined ? {} : { min })}
      {...(max === undefined ? {} : { max })}
      maxLength={key === "name" ? 80 : key === "keyword" ? 200 : 2048}
      onChange={(event) => update({ [key]: event.target.value })}
      disabled={busy}
      autoCapitalize="none"
      spellCheck={false}
    />
  );

  return (
    <Shell
      toolbar={(sidebarButton) => (
        <Toolbar>
          {sidebarButton}
          <ToolbarTitle>{t("app.name")}</ToolbarTitle>
          <Spacer />
          <Button
            onClick={() => {
              if (!draft) saveDraft({ ...EMPTY_DRAFT });
              setEditing(true);
              setInvalid(null);
            }}
            disabled={busy || !allowed || !draftState.loaded || (!draft && monitors.length >= 50)}
          >
            {t(draft ? "form.resume" : "form.new")}
          </Button>
          <Button onClick={refresh} disabled={!allowed || busy || list.loading || history.loading}>
            {t("monitor.refresh")}
          </Button>
        </Toolbar>
      )}
      sidebar={
        <>
          <h2 className="monitor-sidebar-title">
            {t("monitor.targets", { count: monitors.length })}
          </h2>
          {monitors.map((monitor) => (
            <ListItem
              key={monitor.id}
              title={monitor.name}
              meta={t(`state.${monitor.state}`)}
              selected={selected?.id === monitor.id}
              onClick={() => {
                setSelectedId(monitor.id);
                setPage(0);
                setError(null);
              }}
            />
          ))}
          <p className="monitor-hint">{t("monitor.background")}</p>
        </>
      }
    >
      <div className="monitor-main">
        {!allowed ? <p role="alert">{t("monitor.permission")}</p> : null}
        {shownError ? (
          <p role="alert" className="eui-error-text">
            {networkMessage(t, shownError)}
          </p>
        ) : null}
        {list.loading && !list.data ? <LoadingState /> : null}
        {allowed && !list.loading && !list.error && !selected ? (
          <EmptyState title={t("monitor.empty")} text={t("monitor.emptyHint")} />
        ) : null}
        {selected ? (
          <>
            <div className="monitor-heading">
              <div>
                <h1>{selected.name}</h1>
                <p className="monitor-url">
                  {selected.method} {selected.url}
                </p>
              </div>
              <Badge tone={TONES[selected.state]}>{t(`state.${selected.state}`)}</Badge>
            </div>
            <p className="monitor-hint">{t("monitor.checked", { at: date(selected.checkedAt) })}</p>
            <p className="monitor-hint">{t("monitor.since", { at: date(selected.stateSince) })}</p>
            {selected.lastError ? (
              <p className="monitor-failure">{failure(selected.lastError)}</p>
            ) : null}
            {selected.state === "blocked" ? <p role="alert">{t("form.policy")}</p> : null}
            <dl className="monitor-stats">
              <div>
                <dt>{t("monitor.status")}</dt>
                <dd>{selected.lastStatus ?? t("monitor.noData")}</dd>
              </div>
              <div>
                <dt>{t("monitor.latency")}</dt>
                <dd>{ms(selected.lastMs)}</dd>
              </div>
              <div>
                <dt>{t("monitor.uptime24")}</dt>
                <dd>{percent(selected.uptime24h)}</dd>
              </div>
              <div>
                <dt>{t("monitor.uptime7")}</dt>
                <dd>{percent(selected.uptime7d)}</dd>
              </div>
              <div>
                <dt>{t("monitor.average")}</dt>
                <dd>{ms(selected.avgMs24h)}</dd>
              </div>
            </dl>
            <div className="monitor-actions">
              <Button
                disabled={busy || cooldown > 0 || !selected.enabled}
                onClick={() =>
                  void run(async () => {
                    await app.host.call("net.monitors.check", { id: selected.id });
                    refresh();
                  })
                }
              >
                {cooldown > 0 ? t("monitor.wait", { seconds: cooldown }) : t("monitor.check")}
              </Button>
              <Button
                disabled={busy || !!draft}
                onClick={() => {
                  saveDraft(toDraft(selected));
                  setEditing(true);
                  setInvalid(null);
                }}
              >
                {t("monitor.edit")}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await app.host.call(
                      "net.monitors.save",
                      monitorInput(selected, !selected.enabled),
                    );
                    refresh();
                  })
                }
              >
                {t(selected.enabled ? "monitor.pause" : "monitor.enable")}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => remove(selected)}>
                {t("monitor.delete")}
              </Button>
            </div>
            <p className="monitor-hint">
              {t("monitor.schedule", {
                seconds: selected.intervalSeconds,
                failures: selected.downAfter,
                min: selected.expectStatus.min,
                max: selected.expectStatus.max,
              })}
            </p>
            <p className="monitor-hint">
              {t(
                !selected.notify
                  ? "monitor.notifyOff"
                  : notifyAllowed
                    ? "monitor.notifyOn"
                    : "monitor.notifyMissing",
              )}
            </p>
            <div className="monitor-history-heading">
              <h2>{t("history.title")}</h2>
              <Select
                label={t("history.range")}
                value={range}
                options={[
                  { value: "24", label: t("history.day") },
                  { value: "168", label: t("history.week") },
                  { value: "720", label: t("history.month") },
                ]}
                onChange={(value) => {
                  setRange(value);
                  setPage(0);
                }}
              />
              <Button
                disabled={busy || history.loading || !saveAllowed || checks.length === 0}
                onClick={() =>
                  void run(async () => {
                    await saveTextFile(
                      app,
                      "http-monitor-history.csv",
                      historyCsv(selected, checks),
                      { accept: [".csv"] },
                    );
                  })
                }
              >
                {t("history.export")}
              </Button>
            </div>
            <p className="monitor-hint">{t("history.limit", { count: checks.length })}</p>
            {history.loading ? <LoadingState /> : null}
            <ol className="monitor-timeline" aria-label={t("history.timeline")}>
              {checks
                .slice(0, 60)
                .toReversed()
                .map((check, index) => (
                  <li
                    key={`${check.at}-${index}`}
                    data-ok={check.ok}
                    title={`${date(check.at)} · ${failure(check.error)} · ${ms(check.ms)}`}
                  >
                    <span className="eui-visually-hidden">
                      {date(check.at)} · {check.ok ? t("history.ok") : failure(check.error)} ·{" "}
                      {ms(check.ms)}
                    </span>
                  </li>
                ))}
            </ol>
            {!history.loading && checks.length === 0 ? <p>{t("history.empty")}</p> : null}
            <div className="monitor-table">
              <DataTable
                rows={checks.slice(currentPage * 100, currentPage * 100 + 100)}
                getKey={(check) => String(check.at)}
                label={t("history.title")}
                columns={[
                  { key: "at", label: t("history.at"), render: (check) => date(check.at) },
                  {
                    key: "ok",
                    label: t("history.result"),
                    render: (check) => (
                      <Badge tone={check.ok ? "success" : "danger"}>
                        {check.ok ? t("history.ok") : failure(check.error)}
                      </Badge>
                    ),
                  },
                  {
                    key: "status",
                    label: t("monitor.status"),
                    render: (check) => check.status ?? t("monitor.noData"),
                  },
                  { key: "ms", label: t("monitor.latency"), render: (check) => ms(check.ms) },
                ]}
              />
            </div>
            {pages > 1 ? (
              <div className="monitor-actions">
                <Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                  {t("history.previous")}
                </Button>
                <span>{t("history.page", { page: currentPage + 1, pages })}</span>
                <Button
                  disabled={currentPage >= pages - 1}
                  onClick={() => setPage(currentPage + 1)}
                >
                  {t("history.next")}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <Dialog
        open={editing && !!draft}
        title={t(draft?.id ? "form.editTitle" : "form.newTitle")}
        onClose={() => {
          // Native close also fires after a successful save closes the dialog programmatically.
          if (editing && draft && !busy) closeEditor();
        }}
        actions={
          <>
            <Button disabled={busy} onClick={closeEditor}>
              {t("form.discard")}
            </Button>
            <Button variant="primary" disabled={busy || !allowed} onClick={save}>
              {t("form.save")}
            </Button>
          </>
        }
      >
        {draft ? (
          <>
            <p className="monitor-hint">{t("form.policy")}</p>
            <div className="monitor-form">
              {field("name")}
              {field("url")}
              <Select
                label={t("form.method")}
                value={draft.method}
                options={[
                  { value: "GET", label: "GET" },
                  { value: "HEAD", label: "HEAD" },
                ]}
                disabled={busy}
                onChange={(method) =>
                  update({ method, ...(method === "HEAD" ? { keyword: "" } : {}) })
                }
              />
              {field("interval", "number", 60, 86400)}
              {field("timeout", "number", 1000, 30000)}
              {field("min", "number", 100, 599)}
              {field("max", "number", 100, 599)}
              {draft.method === "GET" ? field("keyword") : null}
              {field("downAfter", "number", 1, 5)}
            </div>
            <div className="monitor-checkboxes">
              <Checkbox
                label={t("form.verifyTls")}
                checked={draft.verifyTls}
                onChange={(verifyTls) => update({ verifyTls })}
                disabled={busy}
              />
              {!draft.verifyTls ? <p className="monitor-failure">{t("form.tlsWarning")}</p> : null}
              <Checkbox
                label={t("form.notify")}
                checked={draft.notify}
                onChange={(notify) => update({ notify })}
                disabled={busy}
              />
              {draft.notify && !notifyAllowed ? (
                <p className="monitor-hint">{t("monitor.notifyMissing")}</p>
              ) : null}
              <Checkbox
                label={t("form.enabled")}
                checked={draft.enabled}
                onChange={(enabled) => update({ enabled })}
                disabled={busy}
              />
            </div>
            {invalid ? (
              <p role="alert" className="eui-error-text">
                {t(`validation.${invalid}`)}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="eui-error-text">
                {networkMessage(t, error)}
              </p>
            ) : null}
            {draftState.error ? (
              <p role="alert" className="eui-error-text">
                {networkMessage(t, draftState.error)}
              </p>
            ) : null}
          </>
        ) : null}
      </Dialog>
    </Shell>
  );
}
