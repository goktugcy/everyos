import { useApp, useAsync } from "@everyos/app-ui";
import { useEffect, useState } from "react";

const CAPS = [
  "system:metrics.read",
  "system:services.read",
  "network:outbound",
  "notifications:send",
];

/** Shared by the window and widget; each reads only its own granted capability subset. */
export function useUptimeData() {
  const app = useApp();
  const [grants, setGrants] = useState<ReadonlySet<string>>(
    () => new Set(CAPS.filter((cap) => app.permissions.has(cap))),
  );
  const [epoch, setEpoch] = useState(0);
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(true);
  const canInfo = grants.has("system:metrics.read");
  const canServices = grants.has("system:services.read");
  const canNetwork = grants.has("network:outbound");
  const info = useAsync(
    async () =>
      canInfo ? { value: await app.host.call("system.info", null), at: Date.now() } : null,
    [app, canInfo, revision, epoch],
  );
  const services = useAsync(
    async () =>
      canServices ? { value: await app.host.call("system.services", null), at: Date.now() } : null,
    [app, canServices, revision, epoch],
  );
  const monitors = useAsync(
    async () =>
      canNetwork
        ? { value: (await app.host.call("net.monitors.list", null)).monitors, at: Date.now() }
        : null,
    [app, canNetwork, revision, epoch],
  );
  const loading = info.loading || services.loading || monitors.loading;
  useEffect(() => {
    const stopGrants = app.permissions.onChange((next) => {
      setGrants(new Set(next));
      setEpoch((value) => value + 1);
    });
    const stopSuspend = app.lifecycle.onSuspend(() => setVisible(false));
    const stopResume = app.lifecycle.onResume(() => {
      setVisible(true);
      setRevision((value) => value + 1);
    });
    return () => {
      stopGrants();
      stopSuspend();
      stopResume();
    };
  }, [app]);
  useEffect(() => {
    if (!visible || loading || (!canInfo && !canServices && !canNetwork)) return;
    const timer = setInterval(() => setRevision((value) => value + 1), 15000);
    return () => clearInterval(timer);
  }, [visible, loading, canInfo, canServices, canNetwork]);
  return {
    grants,
    epoch,
    loading,
    visible,
    info: canInfo ? (info.data ?? null) : null,
    services: canServices ? (services.data ?? null) : null,
    monitors: canNetwork ? (monitors.data ?? null) : null,
    infoError: canInfo ? info.error : null,
    servicesError: canServices ? services.error : null,
    monitorsError: canNetwork ? monitors.error : null,
    refresh: () => setRevision((value) => value + 1),
  };
}
