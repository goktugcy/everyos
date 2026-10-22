import { isBridgeError } from "@everyos/app-sdk";
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  LoadingState,
  Select,
  Shell,
  Spacer,
  TextField,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  exportJson,
  formatBytes,
  networkMessage,
  useApp,
  useAsync,
  useI18n,
  usePersistentState,
  useT,
} from "@everyos/app-ui";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  diagnosticReport,
  probeUrl,
  readSettings,
  type Probe,
  type ProbeAttempt,
  type Settings,
} from "./network.ts";

const CAPS = ["system:network.read", "system:metrics.read", "network:outbound", "files:save"];
const errorCode = (error: unknown) =>
  error ? (isBridgeError(error) ? error.code : "unknown") : null;

export function NetworkApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const [grants, setGrants] = useState<ReadonlySet<string>>(
    () => new Set(CAPS.filter((cap) => app.permissions.has(cap))),
  );
  const [stored, saveSettings, storage] = usePersistentState<unknown>("settings", DEFAULT_SETTINGS);
  const settings = readSettings(stored);
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(true);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [attempt, setAttempt] = useState<ProbeAttempt | null>(null);
  const [probeError, setProbeError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  const [checking, setChecking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);
  const generation = useRef(0);
  const activeProbe = useRef(false);
  const networkAllowed = grants.has("system:network.read");
  const metricsAllowed = grants.has("system:metrics.read");
  const probeAllowed = grants.has("network:outbound");
  const network = useAsync(
    async () =>
      networkAllowed
        ? { value: await app.host.call("system.network", null), retrievedAt: Date.now() }
        : null,
    [app, networkAllowed, revision],
  );
  const metrics = useAsync(
    async () =>
      metricsAllowed
        ? { value: await app.host.call("system.metrics", null), retrievedAt: Date.now() }
        : null,
    [app, metricsAllowed, revision],
  );
  const networkSnapshot = networkAllowed ? (network.data ?? null) : null;
  const metricsSnapshot = metricsAllowed ? (metrics.data ?? null) : null;
  const net = networkSnapshot?.value;
  const selectedInterface =
    net?.interfaces.find((entry) => entry.name === settings.interfaceName) ??
    net?.interfaces[0] ??
    null;
  const met = metricsSnapshot?.value ?? null;
  const loading = network.loading || metrics.loading;
  const refresh = () => setRevision((n) => n + 1);
  useEffect(() => {
    const stopGrants = app.permissions.onChange((next) => {
      setGrants(new Set(next));
      generation.current++;
      activeProbe.current = false;
      setChecking(false);
      setProbe(null);
      setAttempt(null);
      setProbeError(null);
    });
    const stopSuspend = app.lifecycle.onSuspend(() => setVisible(false));
    const stopResume = app.lifecycle.onResume(() => {
      setVisible(true);
      setRevision((n) => n + 1);
    });
    return () => {
      stopGrants();
      stopSuspend();
      stopResume();
      generation.current++;
    };
  }, [app]);
  useEffect(() => {
    if (!visible || !settings.auto || loading || (!networkAllowed && !metricsAllowed)) return;
    const timer = setInterval(() => setRevision((n) => n + 1), 10000);
    return () => clearInterval(timer);
  }, [visible, settings.auto, loading, networkAllowed, metricsAllowed]);
  const update = (next: Partial<Settings>) => {
    saveSettings({ ...settings, ...next });
    setInvalid(false);
  };
  const runProbe = async () => {
    if (!probeAllowed || activeProbe.current) return;
    const target = probeUrl(settings.url);
    if (!target) {
      setInvalid(true);
      setProbe(null);
      setAttempt(null);
      setProbeError(null);
      return;
    }
    const current = ++generation.current;
    activeProbe.current = true;
    setChecking(true);
    setProbe(null);
    setAttempt({ at: Date.now(), target });
    setProbeError(null);
    setInvalid(false);
    try {
      const reply = await app.host.call("net.http", {
        method: "HEAD",
        url: target,
        followRedirects: true,
        verifyTls: true,
        timeoutMs: 10000,
      });
      if (current === generation.current) setProbe({ at: Date.now(), target, reply });
    } catch (error) {
      if (current === generation.current) setProbeError(error);
    } finally {
      if (current === generation.current) {
        activeProbe.current = false;
        setChecking(false);
      }
    }
  };
  const saveReport = async () => {
    if (exporting || !grants.has("files:save")) return;
    setExporting(true);
    setExportError(null);
    try {
      await exportJson(
        app,
        "network-diagnostics.json",
        diagnosticReport(
          {
            network: networkSnapshot,
            metrics: metricsSnapshot,
            networkError: networkAllowed ? errorCode(network.error) : "EVERYOS_PERMISSION_DENIED",
            metricsError: metricsAllowed ? errorCode(metrics.error) : "EVERYOS_PERMISSION_DENIED",
            probe,
            attempt,
            probeError: errorCode(probeError),
          },
          Date.now(),
        ),
      );
    } catch (error) {
      setExportError(error);
    } finally {
      setExporting(false);
    }
  };
  const date = (at: number | null) =>
    at === null
      ? t("network.unavailable")
      : i18n.date(at, { dateStyle: "short", timeStyle: "medium" });
  const unavailable = t("network.unavailable");
  const rate = (value: number | null | undefined) =>
    value === null || value === undefined
      ? unavailable
      : t("network.rate", { value: formatBytes(value, i18n.tag) });
  const loadError = (error: unknown, permissionKey = "network.permission") =>
    t(
      isBridgeError(error) &&
        ["FORBIDDEN", "EVERYOS_PERMISSION_DENIED", "AGENT_OPERATION_DENIED"].includes(error.code)
        ? permissionKey
        : isBridgeError(error) && error.code === "HOST_CAPABILITY_UNAVAILABLE"
          ? "network.unsupported"
          : "network.loadFailed",
    );
  const source = (value: "host" | "simulated") => (
    <Badge tone={value === "simulated" ? "warning" : "neutral"}>{t(`source.${value}`)}</Badge>
  );

  return (
    <Shell
      toolbar={() => (
        <Toolbar>
          <ToolbarTitle>{t("app.name")}</ToolbarTitle>
          <Spacer />
          <Button onClick={refresh} disabled={loading || (!networkAllowed && !metricsAllowed)}>
            {t("network.refresh")}
          </Button>
          <Button
            onClick={() => void saveReport()}
            disabled={exporting || !grants.has("files:save") || (loading && !net && !met)}
          >
            {t("network.export")}
          </Button>
        </Toolbar>
      )}
    >
      <div className="network-main">
        {storage.error || exportError ? (
          <p role="alert" className="eui-error-text">
            {errorMessage(t, exportError ?? storage.error)}
          </p>
        ) : null}
        {storage.loaded ? (
          <Checkbox
            label={t("network.auto")}
            checked={settings.auto}
            onChange={(auto) => update({ auto })}
          />
        ) : null}
        <section>
          <h2>{t("network.interfaces")}</h2>
          {!networkAllowed ? <p role="alert">{t("network.permission")}</p> : null}
          {networkAllowed && network.error ? (
            <p role="alert" className="eui-error-text">
              {loadError(network.error)}
            </p>
          ) : null}
          {network.loading ? <LoadingState /> : null}
          {net && networkSnapshot ? (
            <>
              <div className="network-meta">
                {source(net.source)}
                <span>{t("network.retrieved", { at: date(networkSnapshot.retrievedAt) })}</span>
              </div>
              {net.source === "simulated" ? <p role="status">{t("source.simulatedHint")}</p> : null}
              {network.error ? <p className="network-warning">{t("network.stale")}</p> : null}
              <div className="network-internet">
                <Badge
                  tone={
                    net.internet.state === "online"
                      ? "success"
                      : net.internet.state === "offline"
                        ? "warning"
                        : "neutral"
                  }
                >
                  {t(`internet.${net.internet.state}`)}
                </Badge>
                <span>{t("network.internetChecked", { at: date(net.internet.checkedAt) })}</span>
                {net.internet.latencyMs !== null ? (
                  <span>{t("network.ms", { value: i18n.number(net.internet.latencyMs) })}</span>
                ) : null}
              </div>
              <p className="network-hint">{t("network.internetHint")}</p>
              {net.interfaces.length === 0 ? <p>{t("network.noInterfaces")}</p> : null}
              {selectedInterface ? (
                <Select
                  label={t("network.interface")}
                  value={selectedInterface.name}
                  options={net.interfaces.map((entry) => ({
                    value: entry.name,
                    label: entry.name,
                  }))}
                  onChange={(interfaceName) => update({ interfaceName })}
                />
              ) : null}
              {net.interfaces
                .filter((entry) => entry.name === selectedInterface?.name)
                .map((entry) => {
                  return (
                    <article className="network-interface" key={entry.name}>
                      <div className="network-interface-title">
                        <h3>{entry.name}</h3>
                        <Badge tone={entry.up ? "success" : "neutral"}>
                          {t(entry.up ? "network.up" : "network.down")}
                        </Badge>
                        <span>{t(`kind.${entry.kind}`)}</span>
                      </div>
                      <dl className="network-details">
                        <dt>{t("network.addresses")}</dt>
                        <dd>
                          {entry.addresses.length
                            ? entry.addresses.map((address) => (
                                <code
                                  key={`${address.family}/${address.address}/${address.prefix}`}
                                >
                                  {address.address}/{address.prefix}
                                </code>
                              ))
                            : unavailable}
                        </dd>
                        <dt>{t("network.mac")}</dt>
                        <dd>
                          <code>{entry.mac ?? unavailable}</code>
                        </dd>
                        <dt>{t("network.mtu")}</dt>
                        <dd>{entry.mtu === null ? unavailable : i18n.number(entry.mtu)}</dd>
                        <dt>{t("network.speed")}</dt>
                        <dd>
                          {entry.speedMbps === null
                            ? unavailable
                            : t("network.mbps", { value: i18n.number(entry.speedMbps) })}
                        </dd>
                      </dl>
                    </article>
                  );
                })}
              <h2>{t("network.routes")}</h2>
              <p className="network-hint">{t("network.routesHint")}</p>
              {net.gateways.length ? (
                <div className="network-table">
                  <DataTable
                    label={t("network.routes")}
                    rows={net.gateways.map((row, index) => ({ ...row, key: String(index) }))}
                    getKey={(row) => row.key}
                    columns={[
                      {
                        key: "interface",
                        label: t("network.interface"),
                        render: (row) => row.interface,
                      },
                      {
                        key: "family",
                        label: t("network.family"),
                        render: (row) => (row.family === "ipv4" ? "IPv4" : "IPv6"),
                      },
                      {
                        key: "address",
                        label: t("network.gateway"),
                        render: (row) => <code>{row.address}</code>,
                      },
                    ]}
                  />
                </div>
              ) : (
                <p>{t("network.noGateways")}</p>
              )}
              <h2>{t("network.dns")}</h2>
              {net.dns.length ? (
                <ul className="network-dns">
                  {net.dns.map((server, index) => (
                    <li key={`${server}/${index}`}>
                      <code>{server}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t("network.noDns")}</p>
              )}
            </>
          ) : null}
        </section>
        <section>
          <h2>{t("network.traffic")}</h2>
          {!metricsAllowed ? <p role="alert">{t("network.metricsPermission")}</p> : null}
          {metricsAllowed && metrics.error ? (
            <p role="alert" className="eui-error-text">
              {loadError(metrics.error, "network.metricsPermission")}
            </p>
          ) : null}
          {metrics.loading ? <LoadingState /> : null}
          {met ? (
            <>
              <div className="network-meta">
                {source(met.source)}
                <span>{t("network.measured", { at: date(met.point.at) })}</span>
                {metricsSnapshot ? (
                  <span>{t("network.retrieved", { at: date(metricsSnapshot.retrievedAt) })}</span>
                ) : null}
              </div>
              {met.source === "simulated" ? <p role="status">{t("source.simulatedHint")}</p> : null}
              {metrics.error ? <p className="network-warning">{t("network.stale")}</p> : null}
              {met.interfaces === null || met.interfaces.length === 0 ? (
                <p>{t("network.noTraffic")}</p>
              ) : (
                <div className="network-table">
                  <DataTable
                    label={t("network.traffic")}
                    rows={met.interfaces}
                    getKey={(row) => row.name}
                    columns={[
                      { key: "name", label: t("network.interface"), render: (row) => row.name },
                      {
                        key: "rx",
                        label: t("network.receive"),
                        render: (row) => rate(row.rxBytesPerSec),
                      },
                      {
                        key: "tx",
                        label: t("network.transmit"),
                        render: (row) => rate(row.txBytesPerSec),
                      },
                    ]}
                  />
                </div>
              )}
            </>
          ) : null}
        </section>
        <section>
          <h2>{t("diagnostic.title")}</h2>
          <p className="network-hint">{t("diagnostic.policy")}</p>
          {!probeAllowed ? <p role="alert">{t("diagnostic.permission")}</p> : null}
          <form
            className="network-probe"
            onSubmit={(event) => {
              event.preventDefault();
              void runProbe();
            }}
          >
            <TextField
              label={t("diagnostic.url")}
              value={settings.url}
              onChange={(event) => update({ url: event.target.value })}
              maxLength={2048}
              disabled={!storage.loaded}
              autoCapitalize="none"
              spellCheck={false}
            />
            <Button type="submit" disabled={!probeAllowed || checking || !storage.loaded}>
              {t(checking ? "diagnostic.checking" : "diagnostic.check")}
            </Button>
          </form>
          {invalid ? (
            <p role="alert" className="eui-error-text">
              {t("diagnostic.invalid")}
            </p>
          ) : null}
          {probeError ? (
            <p role="alert" className="eui-error-text">
              {networkMessage(t, probeError)}
            </p>
          ) : null}
          {attempt && !probe ? (
            <p className="network-hint">
              {t("diagnostic.attempt", { url: attempt.target, at: date(attempt.at) })}
            </p>
          ) : null}
          {probe ? (
            <div className="network-probe-result">
              <h3>{t("diagnostic.responded")}</h3>
              <code>{probe.target}</code>
              <dl className="network-details">
                <dt>{t("diagnostic.status")}</dt>
                <dd>
                  {probe.reply.status} {probe.reply.statusText}
                </dd>
                <dt>{t("diagnostic.address")}</dt>
                <dd>{probe.reply.remoteAddress}</dd>
                <dt>{t("diagnostic.time")}</dt>
                <dd>{date(probe.at)}</dd>
                <dt>{t("diagnostic.elapsed")}</dt>
                <dd>{t("network.ms", { value: i18n.number(probe.reply.timing.total) })}</dd>
                <dt>{t("diagnostic.redirects")}</dt>
                <dd>{i18n.number(probe.reply.redirects.length)}</dd>
              </dl>
              <p className="network-hint">{t("diagnostic.responseHint")}</p>
            </div>
          ) : null}
        </section>
      </div>
    </Shell>
  );
}
