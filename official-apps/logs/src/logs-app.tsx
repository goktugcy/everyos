import { isBridgeError, type LogEntry, type LogPage } from "@everyos/app-sdk";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  IconButton,
  LoadingState,
  SearchInput,
  Select,
  Shell,
  Spacer,
  TextField,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  exportJson,
  formatBytes,
  useApp,
  useI18n,
  usePersistentState,
  useT,
} from "@everyos/app-ui";
import { Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_DRAFT,
  MAX_BYTES,
  MAX_ENTRIES,
  logReport,
  queryFor,
  readDraft,
  readPresets,
  type Draft,
  type Preset,
} from "./logs.ts";
import { useLogData } from "./use-log-data.ts";

export function LogsApp() {
  const app = useApp(),
    t = useT(),
    i18n = useI18n();
  const [storedDraft, saveDraft, draftState] = usePersistentState<unknown>("draft", DEFAULT_DRAFT);
  const [storedPresets, savePresets, presetsState] = usePersistentState<unknown>("filters", []);
  const [storedLive, saveLive, liveState] = usePersistentState<unknown>("live", false);
  const draft = readDraft(storedDraft),
    presets = readPresets(storedPresets);
  const [allowed, setAllowed] = useState(() => app.permissions.has("logs:read"));
  const [saveAllowed, setSaveAllowed] = useState(() => app.permissions.has("files:save"));
  const [applied, setApplied] = useState<Draft | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<{ entry: LogEntry; source: LogPage["source"] } | null>(null);
  const initialized = useRef(false);
  const canLive = !!applied && (applied.range !== "custom" || !applied.until);
  const live = storedLive === true && canLive && allowed;
  const data = useLogData(app, allowed, applied, live);
  const view = data.view;
  const pages = Math.max(1, Math.ceil((view?.entries.length ?? 0) / 100));
  const currentPage = Math.min(page, pages - 1);
  const storageError = draftState.error ?? presetsState.error ?? liveState.error;
  const ready = draftState.loaded && presetsState.loaded && liveState.loaded;

  useEffect(() => {
    if (!draftState.loaded || initialized.current) return;
    initialized.current = true;
    const initial = readDraft(storedDraft),
      parsed = queryFor(initial, Date.now());
    if ("error" in parsed) setInvalid(parsed.error);
    else setApplied(initial);
  }, [draftState.loaded, storedDraft]);
  useEffect(
    () =>
      app.permissions.onChange((granted) => {
        setAllowed(granted.has("logs:read"));
        setSaveAllowed(granted.has("files:save"));
        if (!granted.has("logs:read")) setDetail(null);
      }),
    [app],
  );
  const update = (next: Partial<Draft>) => {
    saveDraft({ ...draft, ...next });
    setInvalid(null);
  };
  const apply = (next = draft) => {
    if (data.busy) return;
    const parsed = queryFor(next, Date.now());
    if ("error" in parsed) {
      setInvalid(parsed.error);
      return;
    }
    if (parsed.query.until !== undefined) {
      data.pause();
      saveLive(false);
    }
    setApplied({ ...next });
    setPage(0);
    setDetail(null);
    setInvalid(null);
    setActionError(null);
  };
  const toggleLive = () => {
    if (live) {
      data.pause();
      saveLive(false);
    } else {
      saveLive(true);
      setPage(0);
      void data.request("tail");
    }
  };
  const action = async (run: () => Promise<void>) => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await run();
    } catch (error) {
      setActionError(error);
    } finally {
      setActionBusy(false);
    }
  };
  const saveFilter = () =>
    void action(async () => {
      const parsed = queryFor(draft, Date.now());
      if ("error" in parsed) {
        setInvalid(parsed.error);
        return;
      }
      if (presets.length >= 20) {
        setInvalid("presetLimit");
        return;
      }
      const name = await app.dialogs.prompt(t("filters.saveTitle"), t("filters.nameHint"), {
        value: draft.unit,
      });
      if (name === null) return;
      if (!name.trim() || name.trim().length > 80) {
        setInvalid("name");
        return;
      }
      const preset: Preset = {
        id: `filter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        name: name.trim(),
        draft,
      };
      savePresets((current: unknown) => [...readPresets(current), preset]);
    });
  const removeFilter = (preset: Preset) =>
    void action(async () => {
      if (
        await app.dialogs.confirm(
          t("filters.deleteTitle"),
          t("filters.deleteText", { name: preset.name }),
          { destructive: true },
        )
      )
        savePresets((current: unknown) =>
          readPresets(current).filter((item) => item.id !== preset.id),
        );
    });
  const exportView = () =>
    void action(async () => {
      if (view && applied) await exportJson(app, "logs.json", logReport(view, applied, Date.now()));
    });
  const date = (at: number) => i18n.date(at, { dateStyle: "short", timeStyle: "medium" });
  const severity = (priority: number) => (
    <Badge tone={priority <= 3 ? "danger" : priority === 4 ? "warning" : "neutral"}>
      {t(`priority.${priority}`)}
    </Badge>
  );
  const source = (kind: LogPage["source"]) => (
    <Badge tone={kind === "simulated" ? "warning" : "neutral"}>{t(`source.${kind}`)}</Badge>
  );
  const logError = (error: unknown) =>
    t(
      isBridgeError(error) &&
        ["FORBIDDEN", "EVERYOS_PERMISSION_DENIED", "AGENT_OPERATION_DENIED"].includes(error.code)
        ? "logs.permission"
        : isBridgeError(error) && error.code === "HOST_CAPABILITY_UNAVAILABLE"
          ? "logs.unsupported"
          : "logs.loadFailed",
    );
  const turnPage = (next: number) => {
    data.pause();
    saveLive(false);
    setPage(next);
  };

  return (
    <Shell
      toolbar={(sidebarButton) => (
        <Toolbar>
          {sidebarButton}
          <ToolbarTitle>{t("app.name")}</ToolbarTitle>
          <Spacer />
          <IconButton
            label={t(live ? "logs.pause" : "logs.resume")}
            icon={live ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
            pressed={live}
            onClick={toggleLive}
            disabled={!ready || !allowed || !canLive}
          />
          <Button onClick={exportView} disabled={!view || !applied || !saveAllowed || actionBusy}>
            {t("logs.export")}
          </Button>
        </Toolbar>
      )}
      sidebar={
        <>
          <h2 className="logs-sidebar-title">{t("filters.title", { count: presets.length })}</h2>
          {presets.map((preset) => (
            <div className="logs-preset" key={preset.id}>
              <Button
                disabled={data.busy || !ready}
                onClick={() => {
                  saveDraft(preset.draft);
                  apply(preset.draft);
                }}
              >
                {preset.name}
              </Button>
              <IconButton
                label={t("filters.remove", { name: preset.name })}
                icon={<Trash2 size={15} aria-hidden />}
                disabled={actionBusy || !ready}
                onClick={() => removeFilter(preset)}
              />
            </div>
          ))}
          {presets.length === 0 ? <p className="logs-hint">{t("filters.empty")}</p> : null}
        </>
      }
    >
      <div className="logs-main">
        {!ready ? (
          <LoadingState />
        ) : (
          <form
            className="logs-form"
            onSubmit={(event) => {
              event.preventDefault();
              apply();
            }}
          >
            <SearchInput
              label={t("logs.search")}
              placeholder={t("logs.searchHint")}
              value={draft.search}
              onChange={(search) => update({ search: search.slice(0, 200) })}
            />
            <TextField
              label={t("logs.unit")}
              hint={t("logs.unitHint")}
              value={draft.unit}
              maxLength={260}
              onChange={(event) => update({ unit: event.target.value })}
              autoCapitalize="none"
              spellCheck={false}
            />
            <Select
              label={t("logs.priority")}
              value={draft.priority}
              options={[
                { value: "all", label: t("logs.allPriorities") },
                ...Array.from({ length: 8 }, (_, i) => ({
                  value: String(i),
                  label: t(`priority.${i}`),
                })),
              ]}
              onChange={(priority) => update({ priority })}
            />
            <Select
              label={t("logs.range")}
              value={draft.range}
              options={["15m", "1h", "24h", "7d", "all", "custom"].map((value) => ({
                value,
                label: t(`range.${value}`),
              }))}
              onChange={(range) => update({ range })}
            />
            {draft.range === "custom" ? (
              <>
                <TextField
                  label={t("logs.since")}
                  type="datetime-local"
                  value={draft.since}
                  onChange={(event) => update({ since: event.target.value })}
                />
                <TextField
                  label={t("logs.until")}
                  type="datetime-local"
                  value={draft.until}
                  onChange={(event) => update({ until: event.target.value })}
                />
              </>
            ) : null}
            <div className="logs-actions">
              <Button type="submit" variant="primary" disabled={!allowed || data.busy}>
                {t("logs.apply")}
              </Button>
              <Button
                onClick={() => void data.request("replace")}
                disabled={!allowed || !applied || data.busy}
              >
                {t("logs.refresh")}
              </Button>
              <Button onClick={saveFilter} disabled={actionBusy || !ready || presets.length >= 20}>
                {t("filters.save")}
              </Button>
            </div>
          </form>
        )}
        <p className="logs-hint">{t("logs.filterHint")}</p>
        {draft.range === "custom" ? (
          <p className="logs-hint">
            {t("logs.timezone", { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })}
          </p>
        ) : null}
        {invalid ? (
          <p role="alert" className="eui-error-text">
            {t(`validation.${invalid}`)}
          </p>
        ) : null}
        {!allowed ? <p role="alert">{t("logs.permission")}</p> : null}
        {allowed && data.error ? (
          <p role="alert" className="eui-error-text">
            {logError(data.error)}
          </p>
        ) : null}
        {actionError || storageError ? (
          <p role="alert" className="eui-error-text">
            {errorMessage(t, actionError ?? storageError)}
          </p>
        ) : null}
        <div className="logs-status">
          <Badge tone={live && data.visible ? "success" : "neutral"}>
            {t(live && data.visible ? "logs.live" : "logs.paused")}
          </Badge>
          <span>{t("logs.pollHint")}</span>
        </div>
        {!canLive && applied ? <p className="logs-hint">{t("logs.liveUntilHint")}</p> : null}
        {data.busy ? <LoadingState /> : null}
        {view ? (
          <>
            <div className="logs-status">
              {source(view.source)}
              <span>{t("logs.retrieved", { at: date(view.retrievedAt) })}</span>
            </div>
            {view.source === "simulated" ? (
              <p role="status" className="logs-warning">
                {t("source.simulatedHint")}
              </p>
            ) : null}
            <p className="logs-hint">
              {t("logs.applied", {
                unit: view.query.unit ?? t("logs.allUnits"),
                search: view.query.grep ?? t("logs.anyText"),
                priority:
                  view.query.priority === undefined
                    ? t("logs.allPriorities")
                    : t(`priority.${view.query.priority}`),
                since: view.query.since === undefined ? t("logs.anyTime") : date(view.query.since),
                until: view.query.until === undefined ? t("logs.now") : date(view.query.until),
              })}
            </p>
            <p className="logs-hint">
              {t("logs.bounds", {
                count: view.entries.length,
                bytes: formatBytes(view.bytes, i18n.tag),
                max: MAX_ENTRIES,
                maxBytes: formatBytes(MAX_BYTES, i18n.tag),
              })}
            </p>
            {data.error ? <p className="logs-warning">{t("logs.stale")}</p> : null}
            {view.gap ? (
              <p role="alert" className="logs-warning">
                {t("logs.gap")}
              </p>
            ) : null}
            {view.limited ? <p className="logs-warning">{t("logs.limited")}</p> : null}
            {view.entries.length === 0 ? (
              <EmptyState title={t("logs.empty")} text={t("logs.emptyHint")} />
            ) : null}
            <div className="logs-table">
              <DataTable
                label={t("logs.entries")}
                rows={view.entries.slice(currentPage * 100, currentPage * 100 + 100)}
                getKey={(entry) => entry.cursor}
                onSelect={(entry) => setDetail({ entry, source: view.source })}
                columns={[
                  { key: "time", label: t("logs.time"), render: (entry) => date(entry.ts) },
                  {
                    key: "priority",
                    label: t("logs.severity"),
                    render: (entry) => severity(entry.priority),
                  },
                  {
                    key: "unit",
                    label: t("logs.unit"),
                    render: (entry) => entry.unit ?? entry.identifier ?? t("logs.unavailable"),
                  },
                  {
                    key: "message",
                    label: t("logs.message"),
                    render: (entry) => (
                      <span className="logs-preview">
                        {entry.message.length > 300
                          ? `${entry.message.slice(0, 300)}…`
                          : entry.message}
                      </span>
                    ),
                  },
                ]}
              />
            </div>
            <p className="logs-hint">{t("logs.detailHint")}</p>
            <div className="logs-actions">
              <Button disabled={currentPage === 0} onClick={() => turnPage(currentPage - 1)}>
                {t("logs.previous")}
              </Button>
              <span>{t("logs.page", { page: currentPage + 1, pages })}</span>
              <Button disabled={currentPage >= pages - 1} onClick={() => turnPage(currentPage + 1)}>
                {t("logs.next")}
              </Button>
              <Button
                disabled={
                  !view.hasMore ||
                  view.limited ||
                  view.entries.length >= MAX_ENTRIES ||
                  view.bytes >= MAX_BYTES ||
                  data.busy ||
                  !allowed
                }
                onClick={() => {
                  data.pause();
                  saveLive(false);
                  void data.request("older");
                }}
              >
                {t("logs.older")}
              </Button>
            </div>
          </>
        ) : null}
        <Dialog
          open={!!detail && allowed}
          title={t("logs.detailTitle")}
          onClose={() => setDetail(null)}
          actions={<Button onClick={() => setDetail(null)}>{t("logs.close")}</Button>}
        >
          {detail && allowed ? (
            <>
              {source(detail.source)}
              <dl className="logs-details">
                <dt>{t("logs.time")}</dt>
                <dd>{date(detail.entry.ts)}</dd>
                <dt>{t("logs.severity")}</dt>
                <dd>{severity(detail.entry.priority)}</dd>
                <dt>{t("logs.unit")}</dt>
                <dd>{detail.entry.unit ?? t("logs.unavailable")}</dd>
                <dt>{t("logs.identifier")}</dt>
                <dd>{detail.entry.identifier ?? t("logs.unavailable")}</dd>
                <dt>{t("logs.pid")}</dt>
                <dd>{detail.entry.pid ?? t("logs.unavailable")}</dd>
                <dt>{t("logs.hostname")}</dt>
                <dd>{detail.entry.hostname ?? t("logs.unavailable")}</dd>
              </dl>
              <pre className="logs-message">{detail.entry.message}</pre>
            </>
          ) : null}
        </Dialog>
      </div>
    </Shell>
  );
}
