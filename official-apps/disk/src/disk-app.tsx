import type { FileHandle } from "@everyos/app-sdk";
import {
  Badge,
  Button,
  EmptyState,
  LoadingState,
  Select,
  Shell,
  Spacer,
  Tabs,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  exportJson,
  formatBytes,
  useApp,
  useAsync,
  useI18n,
  usePersistentState,
  useT,
} from "@everyos/app-ui";
import { FolderOpen, HardDrive, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DEFAULT_SETTINGS,
  childPath,
  diskReport,
  folderKey,
  mountKey,
  parentPath,
  readHistory,
  readSettings,
  recordSample,
  usedPercent,
  type FolderScan,
  type StorageScan,
} from "./disk.ts";
import { FolderDetails, TrendView } from "./disk-views.tsx";

const CAPS = ["files:pick", "files:save", "storage:usage.read", "system:metrics.read"];

export function DiskApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const [stored, saveSettings, settingsState] = usePersistentState<unknown>(
    "settings",
    DEFAULT_SETTINGS,
  );
  const [storedHistory, saveHistory, historyState] = usePersistentState<unknown>("history", []);
  const settings = readSettings(stored);
  const history = readHistory(storedHistory);
  const [grants, setGrants] = useState<ReadonlySet<string>>(
    () => new Set(CAPS.filter((cap) => app.permissions.has(cap))),
  );
  const [epoch, setEpoch] = useState(0);
  const [revision, setRevision] = useState(0);
  const [revoked, setRevoked] = useState<ReadonlySet<string>>(new Set());
  const [selectedMount, setSelectedMount] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const canPick = grants.has("files:pick");
  const canScan = canPick && grants.has("storage:usage.read");
  const canStorage = grants.has("system:metrics.read");
  const handles = useAsync(
    () => (canPick ? app.files.handles() : Promise.resolve([])),
    [app, canPick, epoch, revision],
  );
  const root: FileHandle | null = canPick
    ? (handles.data?.find(
        (handle) =>
          handle.id === settings.rootId && handle.kind === "directory" && !revoked.has(handle.id),
      ) ?? null)
    : null;
  const folder = useAsync<FolderScan | null>(async () => {
    if (!root || !canScan) return null;
    const startedAt = Date.now();
    const value = await app.host.call("disk.usage", { handle: root.id, path: settings.path });
    return {
      rootId: root.id,
      name: root.name,
      path: settings.path,
      startedAt,
      at: Date.now(),
      value,
    };
  }, [app, root?.id, settings.path, canScan, epoch, revision]);
  const storage = useAsync<StorageScan | null>(async () => {
    if (!canStorage) return null;
    return { value: await app.host.call("system.storage", null), at: Date.now() };
  }, [app, canStorage, epoch, revision]);
  const scan =
    canScan && root && folder.data?.rootId === root.id && folder.data.path === settings.path
      ? folder.data
      : null;
  const mounts = canStorage ? (storage.data ?? null) : null;
  const mount =
    mounts?.value.mounts.find(
      (value) => mountKey(value.device, value.mountpoint) === selectedMount,
    ) ??
    mounts?.value.mounts[0] ??
    null;
  const busy = folder.loading || storage.loading || handles.loading;
  useEffect(() => {
    const stopGrants = app.permissions.onChange((next) => {
      setGrants(new Set(next));
      setEpoch((value) => value + 1);
    });
    const stopFiles = app.files.onRevoked((ids) => {
      setRevoked((previous) => new Set([...previous, ...ids]));
      setEpoch((value) => value + 1);
    });
    return () => {
      stopGrants();
      stopFiles();
    };
  }, [app]);
  useEffect(() => {
    if (!scan || scan.value.truncated || !historyState.loaded) return;
    saveHistory((raw: unknown) =>
      recordSample(readHistory(raw), folderKey(scan.rootId, scan.path), "host", {
        at: scan.at,
        bytes: scan.value.total,
      }),
    );
  }, [scan, historyState.loaded, saveHistory]);
  useEffect(() => {
    if (!mounts || !mount || !historyState.loaded) return;
    saveHistory((raw: unknown) =>
      recordSample(
        readHistory(raw),
        mountKey(mount.device, mount.mountpoint),
        mounts.value.source,
        { at: mounts.at, bytes: mount.usedBytes },
      ),
    );
  }, [mounts, mount, historyState.loaded, saveHistory]);
  const navigate = (path: string) => {
    saveSettings({ ...settings, path });
    setActionError(null);
  };
  const choose = async () => {
    if (!canPick || choosing) return;
    setChoosing(true);
    setActionError(null);
    try {
      const [chosen] = await app.files.open({ directory: true, persist: true });
      if (chosen) {
        saveSettings({ ...settings, rootId: chosen.id, path: "", tab: "folder" });
        handles.reload();
      }
    } catch (error) {
      setActionError(error);
    } finally {
      setChoosing(false);
    }
  };
  const saveReport = async () => {
    if (exporting || !grants.has("files:save")) return;
    setExporting(true);
    setActionError(null);
    try {
      await exportJson(app, "disk-report.json", diskReport(scan, mounts, history, Date.now()));
    } catch (error) {
      setActionError(error);
    } finally {
      setExporting(false);
    }
  };
  const date = (at: number) => i18n.date(at, { dateStyle: "medium", timeStyle: "medium" });
  const bytes = (value: number) => formatBytes(value, i18n.tag);
  const source = mounts?.value.source;
  const storageError = settingsState.error || historyState.error;
  return (
    <Shell
      toolbar={() => (
        <Toolbar>
          <ToolbarTitle>{t("app.name")}</ToolbarTitle>
          <Spacer />
          <Button
            icon={<FolderOpen size={16} aria-hidden />}
            disabled={!canPick || choosing || !settingsState.loaded || handles.loading}
            onClick={() => void choose()}
          >
            {t("disk.choose")}
          </Button>
          <Button
            icon={<RefreshCw size={16} aria-hidden />}
            disabled={busy}
            onClick={() => setRevision((value) => value + 1)}
          >
            {t("disk.refresh")}
          </Button>
          <Button
            disabled={exporting || !grants.has("files:save") || (!scan && !mounts)}
            onClick={() => void saveReport()}
          >
            {t("disk.export")}
          </Button>
        </Toolbar>
      )}
    >
      <div className="disk-main">
        <Tabs
          label={t("app.name")}
          value={settings.tab}
          tabs={[
            {
              value: "folder",
              label: t("disk.folder"),
              icon: <FolderOpen size={16} aria-hidden />,
            },
            {
              value: "volumes",
              label: t("disk.volumes"),
              icon: <HardDrive size={16} aria-hidden />,
            },
          ]}
          onChange={(tab) => {
            if (settingsState.loaded) saveSettings({ ...settings, tab });
          }}
        />
        {storageError ? <p role="alert">{errorMessage(t, storageError)}</p> : null}
        {actionError ? <p role="alert">{errorMessage(t, actionError)}</p> : null}
        {!settingsState.loaded ? (
          <LoadingState />
        ) : settings.tab === "folder" ? (
          <>
            <p className="disk-hint">{t("disk.scopeHint")}</p>
            {!canScan ? <p role="status">{t("disk.permission")}</p> : null}
            {handles.error ? <p role="alert">{errorMessage(t, handles.error)}</p> : null}
            {!root && !handles.loading && settings.rootId ? (
              <p role="status">{t("disk.lost")}</p>
            ) : null}
            {root ? (
              <>
                <nav className="disk-path" aria-label={t("disk.location")}>
                  <Button
                    disabled={!settings.path || folder.loading}
                    onClick={() => navigate(parentPath(settings.path))}
                  >
                    {t("disk.up")}
                  </Button>
                  <Button disabled={!settings.path || folder.loading} onClick={() => navigate("")}>
                    {root.name}
                  </Button>
                  {settings.path
                    .split("/")
                    .filter(Boolean)
                    .map((part, index, parts) => (
                      <Button
                        key={parts.slice(0, index + 1).join("/")}
                        disabled={index === parts.length - 1 || folder.loading}
                        onClick={() => navigate(parts.slice(0, index + 1).join("/"))}
                      >
                        {part}
                      </Button>
                    ))}
                </nav>
                {folder.loading ? <LoadingState text={t("disk.scanning")} /> : null}
                {folder.error ? (
                  <p role="alert">
                    {errorMessage(t, folder.error)} {scan ? t("disk.stale") : ""}
                  </p>
                ) : null}
                {scan ? (
                  <>
                    <div className="disk-meta">
                      <Badge>{t("source.host")}</Badge>
                      <span>{t("disk.measured", { at: date(scan.at) })}</span>
                    </div>
                    <p className="disk-hint">{t("disk.scanHint")}</p>
                    {scan.value.truncated ? (
                      <p className="disk-warning" role="status">
                        {t("disk.partial")}
                      </p>
                    ) : null}
                    <FolderDetails
                      key={`${root.id}/${settings.path}`}
                      scan={scan}
                      busy={folder.loading}
                      onNavigate={(name) => {
                        const path = childPath(settings.path, name);
                        if (path !== null) navigate(path);
                        else setActionError(new RangeError("invalid-path"));
                      }}
                    />
                    <TrendView
                      samples={
                        history.find(
                          (value) =>
                            value.key === folderKey(root.id, settings.path) &&
                            value.source === "host",
                        )?.samples ?? []
                      }
                    />
                  </>
                ) : null}
              </>
            ) : handles.loading ? (
              <LoadingState />
            ) : (
              <EmptyState
                icon={<FolderOpen size={30} aria-hidden />}
                title={t("disk.empty")}
                text={t("disk.emptyHint")}
                action={
                  canPick ? (
                    <Button onClick={() => void choose()}>{t("disk.choose")}</Button>
                  ) : undefined
                }
              />
            )}
          </>
        ) : (
          <>
            {!canStorage ? <p role="status">{t("disk.metricsPermission")}</p> : null}
            {storage.loading ? <LoadingState /> : null}
            {storage.error ? (
              <p role="alert">
                {errorMessage(t, storage.error)} {mounts ? t("disk.stale") : ""}
              </p>
            ) : null}
            {mounts ? (
              <>
                <div className="disk-meta">
                  <Badge tone={source === "simulated" ? "warning" : "neutral"}>
                    {t(`source.${source}`)}
                  </Badge>
                  <span>{t("disk.retrieved", { at: date(mounts.at) })}</span>
                </div>
                {source === "simulated" ? (
                  <p className="disk-warning" role="status">
                    {t("source.simulatedHint")}
                  </p>
                ) : null}
                <p className="disk-hint">{t("disk.mountHint")}</p>
                {mount ? (
                  <>
                    <Select
                      label={t("disk.mountpoint")}
                      value={mountKey(mount.device, mount.mountpoint)}
                      onChange={setSelectedMount}
                      options={mounts.value.mounts.map((value) => ({
                        value: mountKey(value.device, value.mountpoint),
                        label: `${value.mountpoint} · ${value.device}`,
                      }))}
                    />
                    <section className="disk-panel" aria-label={t("disk.usage")}>
                      <h2>{mount.mountpoint}</h2>
                      <dl className="disk-stats">
                        <div>
                          <dt>{t("disk.total")}</dt>
                          <dd>{bytes(mount.totalBytes)}</dd>
                        </div>
                        <div>
                          <dt>{t("disk.used")}</dt>
                          <dd>{bytes(mount.usedBytes)}</dd>
                        </div>
                        <div>
                          <dt>{t("disk.available")}</dt>
                          <dd>{bytes(mount.availableBytes)}</dd>
                        </div>
                      </dl>
                      <div
                        className="disk-meter"
                        role="meter"
                        aria-label={t("disk.used")}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={usedPercent(mount.usedBytes, mount.totalBytes)}
                        aria-valuetext={t("disk.usedOf", {
                          used: bytes(mount.usedBytes),
                          total: bytes(mount.totalBytes),
                        })}
                      >
                        <span
                          style={{ width: `${usedPercent(mount.usedBytes, mount.totalBytes)}%` }}
                        />
                      </div>
                      <dl className="disk-mount-meta">
                        <div>
                          <dt>{t("disk.device")}</dt>
                          <dd>{mount.device}</dd>
                        </div>
                        <div>
                          <dt>{t("disk.fs")}</dt>
                          <dd>{mount.fsType || t("disk.unavailable")}</dd>
                        </div>
                        <div>
                          <dt>{t("disk.access")}</dt>
                          <dd>{mount.readOnly ? t("disk.readOnly") : t("disk.writable")}</dd>
                        </div>
                        <div>
                          <dt>{t("disk.inodes")}</dt>
                          <dd>
                            {mount.inodesTotal > 0
                              ? t("disk.inodesFree", {
                                  free: i18n.number(mount.inodesFree),
                                  total: i18n.number(mount.inodesTotal),
                                })
                              : t("disk.unavailable")}
                          </dd>
                        </div>
                      </dl>
                    </section>
                    <TrendView
                      samples={
                        history.find(
                          (value) =>
                            value.key === mountKey(mount.device, mount.mountpoint) &&
                            value.source === source,
                        )?.samples ?? []
                      }
                    />
                  </>
                ) : (
                  <p role="status">{t("disk.noMounts")}</p>
                )}
              </>
            ) : null}
          </>
        )}
      </div>
    </Shell>
  );
}
