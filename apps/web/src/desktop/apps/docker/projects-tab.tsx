import {
  COMPOSE_ACTIONS,
  type ComposeAction,
  type ComposeActionResult,
  type ComposeFileCheck,
  type ComposeProjectView,
} from "@everyos/shared";
import { AlertTriangle, Layers } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { formatDateTime } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { LoadingBlock, ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { dockerErrorMessage, OwnershipBadge } from "./badges.tsx";

/** Actions that interrupt running services ask for confirmation first. */
const CONFIRMED: ReadonlySet<ComposeAction> = new Set(["stop", "restart", "update", "down"]);

function ImportDialog({
  project,
  onClose,
  onImported,
}: {
  project: ComposeProjectView;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const manager = project.managerHint ? t(`docker.projects.managers.${project.managerHint}`) : null;
  const files =
    error instanceof ApiRequestError
      ? ((error.details as { files?: ComposeFileCheck["files"] } | undefined)?.files ?? null)
      : null;

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await api(`/docker/projects/${project.name}/import`, {
        method: "POST",
        body: manager ? { acknowledgeManager: acknowledged } : {},
      });
      onImported();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("docker.projects.importTitle", { name: project.name })}
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-fg-muted">{t("docker.projects.importBody")}</p>
        <ul className="font-mono text-xs text-fg-muted">
          {project.configFiles.map((file) => (
            <li key={file} className="break-all">
              {file}
            </li>
          ))}
        </ul>
        {manager ? (
          <>
            <Alert tone="warning">{t("docker.projects.managerWarning", { manager })}</Alert>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="size-4 accent-[rgb(var(--everyos-accent))]"
              />
              {t("docker.projects.acknowledge")}
            </label>
          </>
        ) : null}
        {files ? (
          <Alert tone="danger" title={t("docker.projects.fileProblems")}>
            <ul className="font-mono text-xs">
              {files.map((file) => (
                <li key={file.path} className="break-all">
                  {file.path}: {t(`docker.projects.fileReasons.${file.reason}`)}
                </li>
              ))}
            </ul>
          </Alert>
        ) : error ? (
          <Alert tone="danger">{dockerErrorMessage(t, error)}</Alert>
        ) : null}
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            loading={pending}
            disabled={manager !== null && !acknowledged}
            onClick={() => void submit()}
          >
            {t("docker.projects.import")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ProjectCard({
  project,
  canManage,
  onChanged,
}: {
  project: ComposeProjectView;
  canManage: boolean;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [importing, setImporting] = useState(false);
  const [pending, setPending] = useState<ComposeAction | "unimport" | null>(null);
  const [result, setResult] = useState<ComposeActionResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const imported = project.ownership === "imported";

  const run = async (action: ComposeAction) => {
    const label = t(`docker.projects.actions.${action}`);
    if (CONFIRMED.has(action)) {
      const ok = await requestConfirm({
        title: t("docker.confirmTitle", { name: project.name, action: label }),
        body: t(`docker.projects.confirm.${action as "stop"}`),
        confirmLabel: label,
        danger: action === "down" || action === "stop",
      });
      if (!ok) return;
    }
    setPending(action);
    setError(null);
    setResult(null);
    try {
      setResult(
        await api<ComposeActionResult>(`/docker/projects/${project.name}/actions`, {
          method: "POST",
          body: { action },
        }),
      );
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(null);
      onChanged();
    }
  };

  const unimport = async () => {
    const ok = await requestConfirm({
      title: t("docker.projects.unimportTitle", { name: project.name }),
      body: t("docker.projects.unimportBody"),
      confirmLabel: t("docker.projects.unimport"),
      danger: false,
    });
    if (!ok) return;
    setPending("unimport");
    try {
      await api(`/docker/projects/${project.name}/import`, { method: "DELETE" });
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(null);
    }
  };

  return (
    <li
      className="glass-inset flex flex-col gap-3 rounded-everyos-md p-3"
      data-testid={`project-${project.name}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <Layers className="size-4 text-fg-muted" aria-hidden />
          {project.name}
        </h3>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          {t("docker.projects.running", {
            running: project.containers.running,
            total: project.containers.total,
          })}
          <OwnershipBadge ownership={project.ownership} />
        </div>
      </div>
      {project.managerHint ? (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("docker.projects.managerWarning", {
            manager: t(`docker.projects.managers.${project.managerHint}`),
          })}
        </p>
      ) : null}
      {project.services.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 text-xs" aria-label={t("docker.projects.services")}>
          {project.services.map((service) => (
            <li key={service} className="rounded-full bg-hover/8 px-2 py-0.5">
              {service}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="break-all font-mono text-xs text-fg-subtle">
        {project.workingDir ?? "—"}
        {project.configFiles.map((file) => (
          <div key={file}>{file}</div>
        ))}
      </div>
      {imported && project.importedAt ? (
        <p className="text-xs text-fg-subtle">
          {t("docker.projects.importedBy", {
            user: project.importedBy ?? "—",
            date: formatDateTime(project.importedAt, i18n.language),
          })}
        </p>
      ) : null}
      {project.ownership === "external" ? (
        <p className="text-xs text-fg-muted">{t("docker.projects.externalHelp")}</p>
      ) : null}
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {imported ? (
            <>
              {COMPOSE_ACTIONS.map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant={action === "down" ? "danger" : action === "up" ? "primary" : "secondary"}
                  loading={pending === action}
                  disabled={pending !== null}
                  onClick={() => void run(action)}
                >
                  {t(`docker.projects.actions.${action}`)}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                loading={pending === "unimport"}
                disabled={pending !== null}
                onClick={() => void unimport()}
              >
                {t("docker.projects.unimport")}
              </Button>
            </>
          ) : project.ownership === "external" && project.containers.total > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => setImporting(true)}>
              {t("docker.projects.import")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {pending && pending !== "unimport" ? (
        <p role="status" className="text-xs text-fg-muted">
          {t("docker.projects.inProgress")}
        </p>
      ) : null}
      {error ? <Alert tone="danger">{dockerErrorMessage(t, error)}</Alert> : null}
      {result ? (
        <details open={!result.ok}>
          <summary
            className={
              result.ok
                ? "cursor-pointer text-xs text-fg-muted"
                : "cursor-pointer text-xs font-semibold text-danger"
            }
          >
            {result.ok ? t("docker.projects.output") : t("docker.projects.failed")}
          </summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-everyos-sm bg-black/25 p-2 font-mono text-xs">
            {result.output || "—"}
          </pre>
        </details>
      ) : null}
      {importing ? (
        <ImportDialog
          project={project}
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            onChanged();
          }}
        />
      ) : null}
    </li>
  );
}

export function ProjectsTab({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const canManage = usePermissions().includes("docker:manage");
  const list = useApiResource<{ source: "host" | "simulated"; projects: ComposeProjectView[] }>(
    "/docker/projects",
    30_000,
    refreshKey,
  );
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-end">
        <SimulatedBadge source={list.data?.source} />
      </div>
      <ResourceError error={list.error} />
      {list.loading ? <LoadingBlock /> : null}
      {list.data && list.data.projects.length === 0 ? (
        <p className="p-6 text-center text-sm text-fg-muted">{t("docker.projects.empty")}</p>
      ) : null}
      <ul className="grid gap-3 @3xl:grid-cols-2">
        {list.data?.projects.map((project) => (
          <ProjectCard
            key={project.name}
            project={project}
            canManage={canManage}
            onChanged={list.reload}
          />
        ))}
      </ul>
    </div>
  );
}
