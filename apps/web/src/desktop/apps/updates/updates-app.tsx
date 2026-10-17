import type { AptUpdates, PackageInfo, RebootStatus, UpdateJobView } from "@everyos/shared";
import {
  AlertTriangle,
  CircleCheck,
  Loader2,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { Tabs } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { LinuxAccountSection } from "../../../features/account/linux-account.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes, formatDateTime, formatRelative } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { useAppStateField } from "../app-context.ts";
import { LoadingBlock, ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { SelfUpdatePanel } from "../../../features/updates/self-update-panel.tsx";
import { updateJobError } from "../../../features/updates/job-error.ts";
import { power } from "../../power/power.tsx";

const TABS = ["packages", "everyos", "history"] as const;

function JobLog({ job, onDone }: { job: UpdateJobView; onDone: (job: UpdateJobView) => void }) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<string[]>(() => job.output.split("\n").filter(Boolean));
  const log = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (job.status !== "running") return;
    const source = new EventSource(`/api/updates/jobs/${job.id}/events`, { withCredentials: true });
    source.addEventListener("line", (event) => {
      const { text } = JSON.parse((event as MessageEvent<string>).data) as { text: string };
      setLines((previous) => [...previous.slice(-2000), text]);
    });
    source.addEventListener("done", (event) => {
      const done = JSON.parse((event as MessageEvent<string>).data) as UpdateJobView;
      setLines(done.output.split("\n").filter(Boolean));
      source.close();
      onDone(done);
    });
    return () => source.close();
  }, [job.id, job.status, onDone]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lines, job.status, job.output]);
  return (
    <section
      className="flex min-h-0 flex-col gap-2 border-t border-line p-3"
      aria-label={t("updates.job.title")}
      data-testid="update-job"
    >
      <div className="flex items-center gap-2 text-sm">
        {job.status === "running" ? (
          <Loader2 className="size-4 animate-spin text-accent" aria-hidden />
        ) : job.status === "succeeded" ? (
          <CircleCheck className="size-4 text-success" aria-hidden />
        ) : (
          <AlertTriangle className="size-4 text-danger" aria-hidden />
        )}
        <span className="font-medium" role="status">
          {t(`updates.job.${job.action}.${job.status}`, { count: job.upgraded ?? 0 })}
        </span>
        {job.error ? (
          <span className="text-xs text-danger">{updateJobError(t, job.error)}</span>
        ) : null}
      </div>
      <pre
        ref={log}
        className="max-h-48 min-h-20 overflow-auto rounded-everyos-md bg-black/40 p-2 font-mono text-[0.72rem] leading-relaxed text-slate-200"
      >
        {job.status === "running" ? lines.join("\n") : job.output}
      </pre>
    </section>
  );
}

function PackageDetails({ name, onClose }: { name: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const info = useApiResource<PackageInfo>(`/updates/packages/${encodeURIComponent(name)}`, null);
  return (
    <aside
      className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-line p-4 text-sm max-md:hidden"
      aria-label={name}
      data-testid="package-details"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="break-all font-semibold">{name}</h3>
        <button type="button" aria-label={t("common.close")} onClick={onClose}>
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <ResourceError error={info.error} />
      {info.data ? (
        <>
          {info.data.summary ? <p className="text-fg-muted">{info.data.summary}</p> : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-fg-muted">{t("updates.details.installed")}</dt>
            <dd className="break-all font-mono">{info.data.installedVersion ?? "—"}</dd>
            <dt className="text-fg-muted">{t("updates.details.candidate")}</dt>
            <dd className="break-all font-mono">{info.data.candidateVersion ?? "—"}</dd>
            <dt className="text-fg-muted">{t("updates.details.section")}</dt>
            <dd>{info.data.section ?? "—"}</dd>
            <dt className="text-fg-muted">{t("updates.details.size")}</dt>
            <dd>
              {info.data.installedSize !== null
                ? formatBytes(info.data.installedSize, i18n.language)
                : "—"}
            </dd>
            <dt className="text-fg-muted">{t("updates.details.origins")}</dt>
            <dd className="break-all">{info.data.origins.join(", ") || "—"}</dd>
            {info.data.homepage ? (
              <>
                <dt className="text-fg-muted">{t("updates.details.homepage")}</dt>
                <dd className="break-all">
                  <a
                    href={info.data.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent underline"
                  >
                    {info.data.homepage}
                  </a>
                </dd>
              </>
            ) : null}
          </dl>
          {info.data.security ? (
            <p className="flex items-center gap-1.5 text-xs font-semibold text-warning">
              <AlertTriangle className="size-3.5" aria-hidden />
              {t("updates.securityUpdate")}
            </p>
          ) : null}
          {info.data.description ? (
            <p className="whitespace-pre-line text-xs leading-relaxed text-fg-muted">
              {info.data.description}
            </p>
          ) : null}
        </>
      ) : info.loading ? (
        <LoadingBlock />
      ) : null}
    </aside>
  );
}

/** Update manager: pending packages, explicit refresh and upgrades, history. */
/** Installed updates that wait for a restart, with the restart itself for administrators. */
function RebootNotice({ revision, canManage }: { revision: number; canManage: boolean }) {
  const { t } = useTranslation();
  const reboot = useApiResource<RebootStatus>("/system/power/reboot", 60_000, revision);
  const status = reboot.data;
  if (!status?.required) return null;
  return (
    <div className="px-4 pt-3" data-testid="reboot-required">
      <Alert tone="warning" title={t("hostPower.rebootRequired.title")}>
        <p>
          {status.packages.length
            ? t("hostPower.rebootRequired.body", { count: status.packages.length })
            : t("hostPower.rebootRequired.generic")}
          {status.reasons.includes("kernel") ? ` ${t("hostPower.rebootRequired.kernel")}` : ""}
        </p>
        {canManage ? (
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => power.ask("reboot")}
          >
            <RotateCcw className="size-4" aria-hidden />
            {t("hostPower.rebootRequired.action")}
          </Button>
        ) : null}
      </Alert>
    </div>
  );
}

export default function UpdatesApp() {
  const { t, i18n } = useTranslation();
  const canManage = usePermissions().includes("system:manage");
  const [tab, setTab] = useAppStateField("tab", TABS, "packages");
  const [revision, setRevision] = useState(0);
  const list = useApiResource<{ updates: AptUpdates; running: UpdateJobView | null }>(
    "/updates",
    null,
    revision,
  );
  const history = useApiResource<{ jobs: UpdateJobView[] }>(
    tab === "history" ? "/updates/jobs" : null,
    null,
    revision,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<string | null>(null);
  const [job, setJob] = useState<UpdateJobView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [authorize, setAuthorize] = useState(false);
  const startingRef = useRef(false);
  const completed = useRef<string | null>(null);
  const reported = list.data?.running;
  const activeJob =
    reported && reported.id !== job?.id && reported.startedAt >= (job?.startedAt ?? 0)
      ? reported
      : (job ?? reported ?? null);
  const busy = starting || activeJob?.status === "running";
  const updates = list.data?.updates;
  // Keep tracking even when another tab is selected or the SSE connection is lost.
  const progress = useApiResource<UpdateJobView>(
    activeJob?.status === "running" ? `/updates/jobs/${activeJob.id}` : null,
    2000,
  );

  const onDone = useCallback((done: UpdateJobView) => {
    if (completed.current === done.id) return;
    completed.current = done.id;
    setJob(done);
    setSelected(new Set());
    setRevision((n) => n + 1);
  }, []);
  useEffect(() => {
    const done = progress.data;
    if (done && done.id === activeJob?.id && done.status !== "running") onDone(done);
  }, [progress.data, activeJob?.id, onDone]);

  const start = async (
    path: "refresh" | "upgrade",
    body: object,
    confirm?: { title: string; body: string; label: string },
  ) => {
    if (startingRef.current || activeJob?.status === "running") return;
    startingRef.current = true;
    setStarting(true);
    try {
      if (confirm) {
        const ok = await requestConfirm({
          title: confirm.title,
          body: confirm.body,
          confirmLabel: confirm.label,
          danger: true,
        });
        if (!ok) return;
      }
      setError(null);
      const started = await api<UpdateJobView>(`/updates/${path}`, { method: "POST", body });
      setJob(started);
      if (started.status !== "running") onDone(started);
    } catch (caught) {
      setError(caught);
      setRevision((n) => n + 1);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  const unavailable =
    list.error instanceof ApiRequestError && list.error.code === "HOST_CAPABILITY_UNAVAILABLE";

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value) => setTab(value as (typeof TABS)[number])}
      className="flex h-full min-h-0 flex-col"
      data-testid="updates-app"
    >
      <Tabs.List
        className="flex shrink-0 gap-1 border-b border-line px-3 pt-2"
        aria-label={t("apps.updates")}
      >
        {TABS.map((value) => (
          <Tabs.Trigger
            key={value}
            value={value}
            className="rounded-t-everyos-sm border-b-2 border-transparent px-3 py-2 text-sm text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=active]:border-accent data-[state=active]:text-fg"
          >
            {t(`updates.tabs.${value}`)}
          </Tabs.Trigger>
        ))}
      </Tabs.List>

      <Tabs.Content value="everyos" className="flex min-h-0 flex-1 flex-col outline-none">
        <SelfUpdatePanel />
      </Tabs.Content>
      <Tabs.Content value="packages" className="flex min-h-0 flex-1 flex-col outline-none">
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2 text-sm font-semibold">
              {updates ? t("updates.summary", { count: updates.total }) : t("apps.updates")}
              {updates && updates.security > 0 ? (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-warning">
                  <AlertTriangle className="size-3.5" aria-hidden />
                  {t("updates.securityCount", { count: updates.security })}
                </span>
              ) : null}
              <SimulatedBadge source={updates?.source} />
            </span>
            <span className="text-xs text-fg-muted">
              {updates?.listsUpdatedAt
                ? t("updates.listsUpdated", {
                    time: formatRelative(updates.listsUpdatedAt, i18n.language),
                  })
                : t("updates.listsUnknown")}
            </span>
          </div>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void start("refresh", {})}
              >
                <RefreshCw className="size-4" aria-hidden />
                {t("updates.refresh")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || selected.size === 0}
                onClick={() =>
                  void start(
                    "upgrade",
                    { packages: [...selected], confirm: true },
                    {
                      title: t("updates.confirm.selectedTitle", { count: selected.size }),
                      body: t("updates.confirm.body"),
                      label: t("updates.confirm.action"),
                    },
                  )
                }
              >
                {t("updates.upgradeSelected", { count: selected.size })}
              </Button>
              <Button
                size="sm"
                disabled={busy || !updates?.total}
                onClick={() =>
                  void start(
                    "upgrade",
                    { all: true, confirm: true },
                    {
                      title: t("updates.confirm.allTitle", { count: updates?.total ?? 0 }),
                      body: t("updates.confirm.body"),
                      label: t("updates.confirm.action"),
                    },
                  )
                }
              >
                <PackageCheck className="size-4" aria-hidden />
                {t("updates.upgradeAll")}
              </Button>
            </div>
          ) : null}
        </div>
        <RebootNotice revision={revision} canManage={canManage} />
        {error ? (
          <div className="px-4 pt-3">
            <Alert tone="danger">{errorMessage(t, error)}</Alert>
          </div>
        ) : null}
        {unavailable ? (
          <p className="p-8 text-center text-sm text-fg-muted">{t("updates.unavailable")}</p>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 flex-1 overflow-auto">
              <ResourceError error={unavailable ? null : list.error} />
              {list.loading ? <LoadingBlock /> : null}
              {updates && updates.packages.length === 0 ? (
                <p className="flex flex-col items-center gap-2 p-10 text-center text-sm text-fg-muted">
                  <CircleCheck className="size-6 text-success" aria-hidden />
                  {t("updates.upToDate")}
                </p>
              ) : null}
              {updates && updates.packages.length > 0 ? (
                <table
                  className="w-full min-w-[560px] text-left text-sm"
                  data-testid="update-table"
                >
                  <thead className="sticky top-0 z-10 bg-[rgb(var(--everyos-surface)/0.95)] text-xs text-fg-muted">
                    <tr>
                      {canManage ? (
                        <th scope="col" className="w-8 px-3 py-1.5">
                          <input
                            type="checkbox"
                            aria-label={t("updates.selectAll")}
                            checked={selected.size === updates.packages.length}
                            onChange={(event) =>
                              setSelected(
                                event.target.checked
                                  ? new Set(updates.packages.map((p) => p.name))
                                  : new Set(),
                              )
                            }
                            className="accent-[rgb(var(--everyos-accent))]"
                          />
                        </th>
                      ) : null}
                      <th scope="col" className="px-2 py-1.5 font-semibold">
                        {t("updates.columns.package")}
                      </th>
                      <th scope="col" className="px-2 py-1.5 font-semibold">
                        {t("updates.columns.current")}
                      </th>
                      <th scope="col" className="px-2 py-1.5 font-semibold">
                        {t("updates.columns.new")}
                      </th>
                      <th scope="col" className="px-2 py-1.5 font-semibold">
                        {t("updates.columns.source")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {updates.packages.map((pkg) => (
                      <tr
                        key={pkg.name}
                        className={cn(
                          "cursor-default border-t border-line hover:bg-hover/5",
                          details === pkg.name && "bg-[rgb(var(--everyos-accent)/0.12)]",
                        )}
                        onClick={() => setDetails(pkg.name)}
                        data-testid="update-row"
                      >
                        {canManage ? (
                          <td className="px-3 py-1" onClick={(event) => event.stopPropagation()}>
                            <input
                              type="checkbox"
                              aria-label={t("updates.select", { name: pkg.name })}
                              checked={selected.has(pkg.name)}
                              onChange={(event) =>
                                setSelected((current) => {
                                  const next = new Set(current);
                                  if (event.target.checked) next.add(pkg.name);
                                  else next.delete(pkg.name);
                                  return next;
                                })
                              }
                              className="accent-[rgb(var(--everyos-accent))]"
                            />
                          </td>
                        ) : null}
                        <td className="px-2 py-1">
                          <span className="flex items-center gap-1.5 font-medium">
                            {pkg.name}
                            {pkg.security ? (
                              <span
                                className="inline-flex items-center gap-0.5 text-xs font-semibold text-warning"
                                title={t("updates.securityUpdate")}
                              >
                                <AlertTriangle className="size-3.5" aria-hidden />
                                <span>{t("updates.security")}</span>
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td className="max-w-40 truncate px-2 py-1 font-mono text-xs text-fg-muted">
                          {pkg.currentVersion ?? "—"}
                        </td>
                        <td className="max-w-40 truncate px-2 py-1 font-mono text-xs">
                          {pkg.version}
                        </td>
                        <td className="max-w-40 truncate px-2 py-1 text-xs text-fg-muted">
                          {pkg.suites}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
            {details ? (
              <PackageDetails key={details} name={details} onClose={() => setDetails(null)} />
            ) : null}
          </div>
        )}
        {activeJob ? <JobLog key={activeJob.id} job={activeJob} onDone={onDone} /> : null}
        {canManage && activeJob?.error === "LINUX_SUDO_REQUIRED" ? (
          <div className="px-3 pb-3">
            <Button size="sm" variant="secondary" onClick={() => setAuthorize(true)}>
              {t("updates.authorize")}
            </Button>
          </div>
        ) : null}
      </Tabs.Content>

      <Tabs.Content value="history" className="min-h-0 flex-1 overflow-auto p-4 outline-none">
        <ResourceError error={history.error} />
        {history.data?.jobs.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("updates.noHistory")}</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {history.data?.jobs.map((entry) => (
            <li key={entry.id} className="glass-inset rounded-everyos-md p-3 text-sm">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">
                    {t(`updates.job.${entry.action}.${entry.status}`, {
                      count: entry.upgraded ?? 0,
                    })}
                  </span>
                  <span className="text-xs text-fg-muted">
                    {formatDateTime(entry.startedAt, i18n.language)} · {entry.username ?? "—"}
                  </span>
                  {entry.packages ? (
                    <span className="truncate text-xs text-fg-subtle">
                      {entry.packages.join(", ")}
                    </span>
                  ) : null}
                </summary>
                {entry.error ? (
                  <p className="mt-2 text-xs text-danger">{updateJobError(t, entry.error)}</p>
                ) : null}
                <pre className="mt-2 max-h-64 overflow-auto rounded-everyos-sm bg-black/40 p-2 font-mono text-[0.72rem] text-slate-200">
                  {entry.output || "—"}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      </Tabs.Content>
      <Dialog open={authorize} onOpenChange={setAuthorize} title={t("linux.unlock")}>
        {authorize ? <LinuxAccountSection /> : null}
      </Dialog>
    </Tabs.Root>
  );
}
