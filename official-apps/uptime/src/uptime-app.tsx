import type { NetMonitor, NetMonitorCheck } from "@everyos/app-sdk";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  LoadingState,
  SearchInput,
  Select,
  Shell,
  Spacer,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  networkMessage,
  useApp,
  useAsync,
  useI18n,
  usePersistentState,
  useT,
} from "@everyos/app-ui";
import { useEffect, useRef, useState } from "react";
import { EndpointFields } from "./endpoint-fields.tsx";
import { AvailabilityHistory, HealthBadge, TONES } from "./uptime-views.tsx";
import {
  EMPTY_DRAFT,
  durationParts,
  healthSummary,
  parseDraft,
  readDraft,
  toDraft,
  type DraftError,
} from "./uptime.ts";
import { useUptimeData } from "./use-uptime-data.ts";

const ACTIVE_STATES = new Set([
  "active",
  "inactive",
  "failed",
  "activating",
  "deactivating",
  "reloading",
]);

export function UptimeApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const data = useUptimeData();
  const [stored, saveDraft, draftState] = usePersistentState<unknown>("draft", null);
  const draft = readDraft(stored);
  const [editing, setEditing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [range, setRange] = useState("24");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState<DraftError | null>(null);
  const [search, setSearch] = useState("");
  const [servicePage, setServicePage] = useState(0);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const mutating = useRef(false);
  const networkAllowed = data.grants.has("network:outbound");
  const monitors = data.monitors?.value ?? [];
  const selected = monitors.find((value) => value.id === selectedId) ?? monitors[0] ?? null;
  const info = data.info?.value ?? null;
  const services = data.services?.value ?? null;
  const stale = !!(data.infoError || data.servicesError || data.monitorsError);
  const health = healthSummary(info, services, data.monitors?.value ?? null, stale, now);
  const history = useAsync(async () => {
    if (!networkAllowed || !selected) return null;
    const result = await app.host.call("net.monitors.history", {
      id: selected.id,
      since: Date.now() - Number(range) * 3600000,
      limit: 5000,
    });
    return { id: selected.id, range, checks: result.checks.toSorted((a, b) => b.at - a.at) };
  }, [app, networkAllowed, selected?.id, range, data.monitors?.at, data.epoch]);
  const checks: NetMonitorCheck[] =
    networkAllowed && history.data?.id === selected?.id && history.data?.range === range
      ? history.data.checks
      : [];
  useEffect(() => {
    const stop = app.permissions.onChange(() => {
      generation.current++;
      mutating.current = false;
      setBusy(false);
      setError(null);
    });
    return () => {
      stop();
      generation.current++;
    };
  }, [app]);
  useEffect(() => {
    if (!data.visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [data.visible]);
  const run = async (action: () => Promise<void>) => {
    if (mutating.current || !app.permissions.has("network:outbound")) return;
    const current = generation.current;
    mutating.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      if (current === generation.current) setError(cause);
    } finally {
      if (current === generation.current) {
        mutating.current = false;
        setBusy(false);
        data.refresh();
        setNow(Date.now());
      }
    }
  };
  const closeEditor = () => {
    if (!editing || busy) return;
    void (async () => {
      if (
        await app.dialogs.confirm(t("form.discardTitle"), t("form.discardText"), {
          destructive: true,
        })
      ) {
        saveDraft(null);
        setEditing(false);
        setInvalid(null);
      }
    })();
  };
  const save = () => {
    if (!draft) return;
    const parsed = parseDraft(draft);
    if ("error" in parsed) {
      setInvalid(parsed.error);
      return;
    }
    const current = generation.current;
    void run(async () => {
      const monitor = await app.host.call("net.monitors.save", parsed.input);
      if (current !== generation.current) return;
      setSelectedId(monitor.id);
      saveDraft(null);
      setEditing(false);
      setInvalid(null);
    });
  };
  const edit = (monitor: NetMonitor | null) => {
    saveDraft(monitor ? toDraft(monitor) : EMPTY_DRAFT);
    setEditing(true);
    setInvalid(null);
    setError(null);
  };
  const remove = (monitor: NetMonitor) =>
    void run(async () => {
      if (
        await app.dialogs.confirm(
          t("monitor.deleteTitle"),
          t("monitor.deleteText", { name: monitor.name }),
          { destructive: true },
        )
      )
        await app.host.call("net.monitors.delete", { id: monitor.id });
    });
  const toggle = (monitor: NetMonitor) => {
    const parsed = parseDraft({ ...toDraft(monitor), enabled: !monitor.enabled });
    if ("input" in parsed)
      void run(async () => {
        await app.host.call("net.monitors.save", parsed.input);
      });
  };
  const date = (at: number | null) =>
    at === null ? t("monitor.never") : i18n.date(at, { dateStyle: "medium", timeStyle: "medium" });
  const duration = (seconds: number) => t("duration.full", durationParts(seconds));
  const units =
    services?.units.filter((unit) =>
      `${unit.name} ${unit.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    ) ?? [];
  const servicePages = Math.max(1, Math.ceil(units.length / 100));
  const currentServicePage = Math.min(servicePage, servicePages - 1);
  const wait = selected?.checkedAt
    ? Math.max(0, Math.ceil((selected.checkedAt + 10000 - now) / 1000))
    : 0;
  return (
    <Shell
      toolbar={() => (
        <Toolbar>
          <ToolbarTitle>{t("app.name")}</ToolbarTitle>
          <Spacer />
          <Button disabled={data.loading || busy} onClick={data.refresh}>
            {t("monitor.refresh")}
          </Button>
          {draft ? (
            <Button disabled={busy || !networkAllowed} onClick={() => setEditing(true)}>
              {t("form.resume")}
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={
              !networkAllowed || busy || monitors.length >= 50 || !draftState.loaded || !!draft
            }
            onClick={() => edit(null)}
          >
            {t("form.new")}
          </Button>
        </Toolbar>
      )}
    >
      <div className="uptime-main">
        <section className="uptime-health">
          <HealthBadge state={health.state} />
          <p>{t("health.hint")}</p>
          {health.limited ? <p role="status">{t("health.limited")}</p> : null}
        </section>
        <p className="uptime-hint">{t("uptime.auto")}</p>
        {data.loading ? <LoadingState /> : null}
        {draftState.error ? <p role="alert">{errorMessage(t, draftState.error)}</p> : null}
        {error && !editing ? <p role="alert">{networkMessage(t, error)}</p> : null}
        <div className="uptime-columns">
          <section className="uptime-panel">
            <h2>{t("host.title")}</h2>
            {!data.grants.has("system:metrics.read") ? (
              <p role="status">{t("host.permission")}</p>
            ) : null}
            {data.infoError ? <p role="alert">{errorMessage(t, data.infoError)}</p> : null}
            {info ? (
              <>
                <Badge tone={info.source === "simulated" ? "warning" : "neutral"}>
                  {t(`source.${info.source}`)}
                </Badge>
                {info.source === "simulated" ? (
                  <p role="status">{t("source.simulatedHint")}</p>
                ) : null}
                <h3>{info.hostname}</h3>
                <strong className="uptime-duration">{duration(info.uptimeSeconds)}</strong>
                <p>{t("host.boot", { at: date(info.bootTime) })}</p>
                <p className="uptime-hint">{t("host.measured", { at: date(info.collectedAt) })}</p>
              </>
            ) : null}
          </section>
          <section className="uptime-panel">
            <h2>{t("endpoints.title")}</h2>
            <p>{t("endpoints.summary", health.counts)}</p>
            <p className="uptime-hint">{t("endpoints.scope")}</p>
          </section>
        </div>
        <section className="uptime-panel">
          <h2>{t("monitor.targets", { count: monitors.length })}</h2>
          {!networkAllowed ? <p role="status">{t("monitor.permission")}</p> : null}
          {data.monitorsError ? <p role="alert">{networkMessage(t, data.monitorsError)}</p> : null}
          <div className="uptime-targets">
            {monitors.map((monitor) => (
              <Button
                key={monitor.id}
                aria-pressed={selected?.id === monitor.id}
                onClick={() => setSelectedId(monitor.id)}
              >
                <span>{monitor.name}</span>
                <Badge tone={TONES[monitor.state]}>{t(`state.${monitor.state}`)}</Badge>
              </Button>
            ))}
          </div>
          {!monitors.length ? (
            <EmptyState title={t("monitor.empty")} text={t("monitor.emptyHint")} />
          ) : null}
          {selected ? (
            <div className="uptime-endpoint">
              <h3>{selected.name}</h3>
              <p className="uptime-url">{selected.url}</p>
              <p>
                {t("monitor.schedule", {
                  seconds: selected.intervalSeconds,
                  min: selected.expectStatus.min,
                  max: selected.expectStatus.max,
                  failures: selected.downAfter,
                })}
              </p>
              <p>{t("monitor.checked", { at: date(selected.checkedAt) })}</p>
              <p>{t("monitor.since", { at: date(selected.stateSince) })}</p>
              {selected.state === "blocked" ? <p role="status">{t("form.policy")}</p> : null}
              <dl className="uptime-stats">
                <div>
                  <dt>{t("monitor.uptime24")}</dt>
                  <dd>
                    {selected.uptime24h === null
                      ? t("monitor.noData")
                      : i18n.number(selected.uptime24h, {
                          style: "percent",
                          maximumFractionDigits: 2,
                        })}
                  </dd>
                </div>
                <div>
                  <dt>{t("monitor.uptime7")}</dt>
                  <dd>
                    {selected.uptime7d === null
                      ? t("monitor.noData")
                      : i18n.number(selected.uptime7d, {
                          style: "percent",
                          maximumFractionDigits: 2,
                        })}
                  </dd>
                </div>
                <div>
                  <dt>{t("monitor.latency")}</dt>
                  <dd>
                    {selected.lastMs === null
                      ? t("monitor.noData")
                      : t("monitor.ms", { value: i18n.number(selected.lastMs) })}
                  </dd>
                </div>
              </dl>
              <div className="uptime-actions">
                <Button
                  disabled={busy || !selected.enabled || !!wait}
                  onClick={() =>
                    void run(async () => {
                      await app.host.call("net.monitors.check", { id: selected.id });
                    })
                  }
                >
                  {wait ? t("monitor.wait", { seconds: wait }) : t("monitor.check")}
                </Button>
                <Button disabled={busy || !!draft} onClick={() => edit(selected)}>
                  {t("monitor.edit")}
                </Button>
                <Button disabled={busy} onClick={() => toggle(selected)}>
                  {t(selected.enabled ? "monitor.pause" : "monitor.enable")}
                </Button>
                <Button disabled={busy} onClick={() => remove(selected)}>
                  {t("monitor.delete")}
                </Button>
              </div>
              <p className="uptime-hint">
                {t(selected.notify ? "monitor.notifyOn" : "monitor.notifyOff")}
              </p>
              {selected.notify && !data.grants.has("notifications:send") ? (
                <p role="status">{t("monitor.notifyMissing")}</p>
              ) : null}
              <Select
                label={t("history.range")}
                value={range}
                options={[
                  { value: "24", label: t("history.day") },
                  { value: "168", label: t("history.week") },
                ]}
                onChange={setRange}
              />
              {history.loading ? <LoadingState /> : null}
              {history.error ? <p role="alert">{networkMessage(t, history.error)}</p> : null}
              <AvailabilityHistory key={`${selected.id}/${range}`} checks={checks} />
            </div>
          ) : null}
        </section>
        <section className="uptime-panel">
          <h2>{t("services.title")}</h2>
          <p className="uptime-hint">{t("services.hint")}</p>
          {!data.grants.has("system:services.read") ? (
            <p role="status">{t("services.permission")}</p>
          ) : null}
          {data.servicesError ? <p role="alert">{errorMessage(t, data.servicesError)}</p> : null}
          {services ? (
            <>
              <Badge tone={services.source === "simulated" ? "warning" : "neutral"}>
                {t(`source.${services.source}`)}
              </Badge>
              {services.source === "simulated" ? (
                <p role="status">{t("source.simulatedHint")}</p>
              ) : null}
              <p>{t("services.observed", { at: date(data.services!.at) })}</p>
              <SearchInput
                label={t("services.search")}
                value={search}
                onChange={(value) => {
                  setSearch(value);
                  setServicePage(0);
                }}
              />
              <div className="uptime-table">
                <DataTable
                  label={t("services.title")}
                  rows={units.slice(currentServicePage * 100, (currentServicePage + 1) * 100)}
                  getKey={(unit) => unit.name}
                  columns={[
                    { key: "name", label: t("services.name"), render: (unit) => unit.name },
                    {
                      key: "description",
                      label: t("services.description"),
                      render: (unit) => unit.description,
                    },
                    {
                      key: "active",
                      label: t("services.state"),
                      render: (unit) =>
                        ACTIVE_STATES.has(unit.active)
                          ? t(`services.activeStates.${unit.active}`)
                          : unit.active,
                    },
                    { key: "sub", label: t("services.sub"), render: (unit) => unit.sub },
                  ]}
                />
              </div>
              {!units.length ? <p>{t("services.empty")}</p> : null}
              <div className="uptime-actions">
                <Button
                  disabled={!currentServicePage}
                  onClick={() => setServicePage(currentServicePage - 1)}
                >
                  {t("history.previous")}
                </Button>
                <span>
                  {t("history.page", { page: currentServicePage + 1, pages: servicePages })}
                </span>
                <Button
                  disabled={currentServicePage + 1 >= servicePages}
                  onClick={() => setServicePage(currentServicePage + 1)}
                >
                  {t("history.next")}
                </Button>
              </div>
            </>
          ) : null}
        </section>
      </div>
      <Dialog
        open={editing && !!draft}
        title={t(draft?.id ? "form.editTitle" : "form.newTitle")}
        onClose={closeEditor}
        actions={
          <>
            <Button disabled={busy} onClick={closeEditor}>
              {t("form.discard")}
            </Button>
            <Button variant="primary" disabled={busy || !networkAllowed} onClick={save}>
              {t("form.save")}
            </Button>
          </>
        }
      >
        {draft ? (
          <EndpointFields
            draft={draft}
            disabled={busy}
            onChange={(patch) => {
              saveDraft({ ...draft, ...patch });
              setInvalid(null);
            }}
          />
        ) : null}
        {invalid ? <p role="alert">{t(`validation.${invalid}`)}</p> : null}
        {error ? <p role="alert">{networkMessage(t, error)}</p> : null}
      </Dialog>
    </Shell>
  );
}
