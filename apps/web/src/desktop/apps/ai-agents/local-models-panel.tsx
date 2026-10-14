import {
  SUGGESTED_LOCAL_MODELS,
  type AppJobView,
  type LocalModelPull,
  type LocalModelServer,
  type LocalModelsView,
  type OllamaAcceleration,
} from "@everyos/shared";
import { Cpu, HardDriveDownload, Power, RefreshCw, Server, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { formatBytes } from "../../../lib/format.ts";
import { Progress } from "../store/parts.tsx";
import { ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { AiAgentIcon } from "./agent-icon.tsx";
import { Badge, ChoiceCard, ChoiceGroup } from "./assistant-form.tsx";
import { ServerSummary } from "./assistant-sections.tsx";

/** Local servers and the EveryOS Ollama; polled faster while something is changing. */
export function useLocalModels() {
  const [fast, setFast] = useState(false);
  const resource = useApiResource<LocalModelsView>(
    "/ai-agents/local-models",
    fast ? 2_000 : 30_000,
  );
  const busy =
    resource.data?.pulls.some((pull) => pull.state === "running") === true ||
    resource.data?.ollama.app?.state === "busy";
  if (busy !== fast) setFast(busy);
  return resource;
}

const ACCELERATIONS: readonly OllamaAcceleration[] = ["cpu", "nvidia", "amd"];

/** Installs the EveryOS Ollama, or changes its acceleration. */
export function OllamaSetupDialog({
  local,
  onClose,
  onStarted,
}: {
  local: LocalModelsView;
  onClose: () => void;
  onStarted: (job: AppJobView) => void;
}) {
  const { t } = useTranslation();
  const [acceleration, setAcceleration] = useState<OllamaAcceleration>(
    local.ollama.app ? local.ollama.acceleration : local.ollama.hardware.nvidia ? "nvidia" : "cpu",
  );
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  const installed = local.ollama.app !== null;
  const start = async () => {
    setPending(true);
    setError(null);
    try {
      const { job } = await api<{ job: AppJobView }>("/ai-agents/local-models/ollama", {
        method: "POST",
        body: { acceleration, confirm: "ollama" },
      });
      onStarted(job);
      onClose();
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={t(installed ? "aiAgents.local.changeAcceleration" : "aiAgents.local.installTitle")}
      description={installed ? undefined : t("aiAgents.local.installPitch")}
    >
      {local.ollama.unavailable && !installed ? (
        <Alert tone="warning">{t(`aiAgents.local.unavailable.${local.ollama.unavailable}`)}</Alert>
      ) : (
        <div className="flex flex-col gap-4">
          <ChoiceGroup label={t("aiAgents.local.acceleration")}>
            {ACCELERATIONS.map((value) => {
              const available = value === "cpu" || local.ollama.hardware[value];
              return (
                <ChoiceCard
                  key={value}
                  testId={`ollama-acceleration-${value}`}
                  selected={acceleration === value}
                  onSelect={() => setAcceleration(value)}
                  disabled={!available}
                  icon={<Cpu className="size-5" />}
                  title={t(`aiAgents.local.accelerations.${value}`)}
                  description={
                    available
                      ? t(`aiAgents.local.accelerationHints.${value}`)
                      : t("aiAgents.local.gpuMissing")
                  }
                  badge={
                    available && value !== "cpu" ? (
                      <Badge>{t("aiAgents.local.detected")}</Badge>
                    ) : null
                  }
                />
              );
            })}
          </ChoiceGroup>
          {acceleration !== "cpu" ? (
            <Alert tone="warning">{t("aiAgents.local.gpuRisk")}</Alert>
          ) : null}
          {!installed ? (
            <p className="text-xs leading-relaxed text-fg-muted">
              {t("aiAgents.local.installDetails")}
            </p>
          ) : null}
          <ResourceError error={error} onDismiss={() => setError(null)} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={pending} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              loading={pending}
              onClick={() => void start()}
              data-testid="ollama-setup-confirm"
            >
              {t(installed ? "common.save" : "aiAgents.local.install")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Downloads a model to an Ollama server; suggestions fit the host's memory. */
export function PullModelDialog({
  server,
  memoryBytes,
  onClose,
  onStarted,
}: {
  server: LocalModelServer;
  memoryBytes: number | null;
  onClose: () => void;
  onStarted: (pull: LocalModelPull) => void;
}) {
  const { t, i18n } = useTranslation();
  const memoryGb = memoryBytes ? memoryBytes / 1024 ** 3 : null;
  const fitting = SUGGESTED_LOCAL_MODELS.filter(
    (model) => memoryGb === null || model.memoryGb <= memoryGb,
  );
  const installed = new Set(server.models.map((model) => model.id));
  const [model, setModel] = useState(
    fitting.findLast((entry) => !installed.has(entry.id))?.id ?? "",
  );
  const external = server.source !== "everyos";
  const [confirmed, setConfirmed] = useState(!external);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  const start = async () => {
    setPending(true);
    setError(null);
    try {
      const { pull } = await api<{ pull: LocalModelPull }>(
        `/ai-agents/local-models/servers/${server.id}/pull`,
        {
          method: "POST",
          body: { model: model.trim(), ...(external ? { confirmExternal: true } : {}) },
        },
      );
      onStarted(pull);
      onClose();
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={t("aiAgents.local.downloadTitle", { server: server.name })}
      description={t("aiAgents.local.downloadHint")}
    >
      <div className="flex flex-col gap-4">
        {fitting.length ? (
          <ChoiceGroup label={t("aiAgents.local.suggested")}>
            {fitting.map((entry) => (
              <ChoiceCard
                key={entry.id}
                testId={`suggested-${entry.id}`}
                selected={model === entry.id}
                onSelect={() => setModel(entry.id)}
                disabled={installed.has(entry.id)}
                title={entry.id}
                description={t("aiAgents.local.suggestedDetails", {
                  size: formatBytes(entry.bytes, i18n.language),
                  memory: entry.memoryGb,
                })}
                badge={
                  installed.has(entry.id) ? (
                    <Badge tone="muted">{t("aiAgents.local.installedModel")}</Badge>
                  ) : null
                }
              />
            ))}
          </ChoiceGroup>
        ) : null}
        <Field
          label={t("aiAgents.local.modelName")}
          hint={t("aiAgents.local.modelNameHint")}
          value={model}
          maxLength={200}
          placeholder="qwen3:4b"
          onChange={(event) => setModel(event.target.value)}
        />
        {external ? (
          <label className="flex items-start gap-2 rounded-everyos-md border border-warning/40 p-3 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>{t("aiAgents.local.externalConfirm", { server: server.name })}</span>
          </label>
        ) : null}
        <ResourceError error={error} onDismiss={() => setError(null)} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            loading={pending}
            disabled={!model.trim() || !confirmed}
            onClick={() => void start()}
            data-testid="model-pull-confirm"
          >
            <HardDriveDownload className="size-4" aria-hidden />
            {t("aiAgents.local.download")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function DeleteModelDialog({
  server,
  model,
  onClose,
  onDeleted,
}: {
  server: LocalModelServer;
  model: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const external = server.source !== "everyos";
  const [confirmed, setConfirmed] = useState(!external);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  const remove = async () => {
    setPending(true);
    setError(null);
    try {
      await api(`/ai-agents/local-models/servers/${server.id}/models`, {
        method: "DELETE",
        body: { model, confirm: model, ...(external ? { confirmExternal: true } : {}) },
      });
      onDeleted();
      onClose();
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={t("aiAgents.local.deleteTitle", { model })}
    >
      <div className="flex flex-col gap-4">
        <Alert tone="warning">{t("aiAgents.local.deleteConfirm", { server: server.name })}</Alert>
        {external ? (
          <label className="flex items-start gap-2 rounded-everyos-md border border-warning/40 p-3 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>{t("aiAgents.local.externalConfirm", { server: server.name })}</span>
          </label>
        ) : null}
        <ResourceError error={error} onDismiss={() => setError(null)} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={pending}
            disabled={!confirmed}
            onClick={() => void remove()}
            data-testid="model-delete-confirm"
          >
            {t("common.delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** A download's progress; finished ones stay visible until the next refresh drops them. */
export function PullProgress({ pull, onChanged }: { pull: LocalModelPull; onChanged: () => void }) {
  const { t, i18n } = useTranslation();
  const percent = pull.total
    ? Math.min(100, Math.round((pull.completed / pull.total) * 100))
    : null;
  return (
    <div
      className="flex flex-col gap-2 rounded-everyos-md border border-line p-3"
      data-testid="model-pull"
      data-state={pull.state}
    >
      <div className="flex items-center gap-2 text-sm">
        <HardDriveDownload className="size-4 shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">{pull.model}</span>
        <span role="status" className="text-xs text-fg-muted">
          {pull.state === "running"
            ? percent !== null
              ? `${percent}% · ${formatBytes(pull.completed, i18n.language)} / ${formatBytes(pull.total, i18n.language)}`
              : pull.status
            : t(`aiAgents.local.pullStates.${pull.state}`)}
        </span>
        {pull.state === "running" ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("aiAgents.local.cancelDownload")}
            onClick={() =>
              void api(`/ai-agents/local-models/pulls/${pull.id}/cancel`, {
                method: "POST",
                body: {},
              }).finally(onChanged)
            }
          >
            <X className="size-4" aria-hidden />
          </Button>
        ) : null}
      </div>
      {pull.state === "running" ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-hover/15">
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${percent ?? 5}%` }}
          />
        </div>
      ) : null}
      {pull.error ? <p className="text-xs text-danger">{pull.error}</p> : null}
    </div>
  );
}

/** EveryOS Ollama, other servers on this host, and their models. */
export function LocalModelsPanel({
  local,
  error,
  reload,
}: {
  local: LocalModelsView | null;
  error: unknown;
  reload: () => void;
}) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState(false),
    [job, setJob] = useState<AppJobView | null>(null),
    [pullFrom, setPullFrom] = useState<LocalModelServer | null>(null),
    [removing, setRemoving] = useState<{ server: LocalModelServer; model: string } | null>(null),
    [actionError, setActionError] = useState<unknown>(null);
  const app = local?.ollama.app ?? null;
  const everyos = local?.servers.find((server) => server.source === "everyos") ?? null;
  const control = async (action: "start" | "stop" | "restart" | "retry") => {
    setActionError(null);
    try {
      const result = await api<{ job: AppJobView }>("/ai-agents/local-models/ollama/actions", {
        method: "POST",
        body: { action, confirm: "ollama" },
      });
      setJob(result.job);
    } catch (error) {
      setActionError(error);
    }
  };
  return (
    <div className="flex flex-col gap-4" data-testid="local-models">
      <ResourceError error={error ?? actionError} onDismiss={() => setActionError(null)} />
      <div
        className="glass-inset flex flex-col gap-3 rounded-everyos-lg p-4"
        data-testid="everyos-ollama"
      >
        <div className="flex flex-wrap items-center gap-3">
          <AiAgentIcon kind="local" className="size-7 text-accent" />
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold">{t("aiAgents.local.everyos")}</h4>
            <p role="status" className="mt-0.5 text-xs text-fg-muted">
              {!local
                ? t("common.loading")
                : !app
                  ? t("aiAgents.local.notInstalled")
                  : t(`aiAgents.local.appStates.${app.lastError ? "error" : app.state}`, {
                      acceleration: t(`aiAgents.local.accelerations.${local.ollama.acceleration}`),
                    })}
              {everyos?.online
                ? ` · ${t("aiAgents.local.modelCount", { count: everyos.models.length })}`
                : ""}
            </p>
          </div>
          <SimulatedBadge source={app?.source} />
          {local && !app ? (
            <Button size="sm" onClick={() => setSetup(true)} data-testid="ollama-install">
              <HardDriveDownload className="size-4" aria-hidden />
              {t("aiAgents.local.install")}
            </Button>
          ) : null}
          {app ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => setSetup(true)}>
                <Cpu className="size-4" aria-hidden />
                {t("aiAgents.local.changeAcceleration")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void control(app.state === "stopped" ? "start" : "restart")}
              >
                {app.state === "stopped" ? (
                  <Power className="size-4" aria-hidden />
                ) : (
                  <RefreshCw className="size-4" aria-hidden />
                )}
                {t(`appStore.actions.${app.state === "stopped" ? "start" : "restart"}`)}
              </Button>
              {app.lastError ? (
                <Button variant="secondary" size="sm" onClick={() => void control("retry")}>
                  {t("common.retry")}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
        {!app && local ? (
          <p className="text-xs leading-relaxed text-fg-muted">
            {t("aiAgents.local.installPitch")}
          </p>
        ) : null}
        {job ? (
          <Progress key={job.id} id={job.id} onChanged={reload} onDismiss={() => setJob(null)} />
        ) : null}
        {everyos ? (
          <ModelList
            server={everyos}
            onPull={() => setPullFrom(everyos)}
            onRemove={(model) => setRemoving({ server: everyos, model })}
          />
        ) : null}
      </div>
      {local?.servers
        .filter((server) => server.source !== "everyos")
        .map((server) => (
          <div
            key={server.id}
            className="glass-inset flex flex-col gap-3 rounded-everyos-lg p-4"
            data-testid={`local-server-${server.id}`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <Server className="size-6 text-accent" aria-hidden />
              <div className="min-w-0 flex-1">
                <h4 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  {server.name}
                  {server.version ? (
                    <span className="text-xs font-normal text-fg-subtle">{server.version}</span>
                  ) : null}
                  {!server.online ? (
                    <Badge tone="warning">{t("aiAgents.local.badges.offline")}</Badge>
                  ) : null}
                  {server.needsKey ? (
                    <Badge tone="warning">{t("aiAgents.local.badges.needsKey")}</Badge>
                  ) : null}
                </h4>
                <p className="mt-0.5 break-all text-xs text-fg-muted">
                  <ServerSummary server={server} />
                </p>
                <p className="mt-0.5 text-xs text-fg-subtle">
                  {t(`aiAgents.local.access.${server.containerAccess}`)}
                </p>
              </div>
            </div>
            {server.online && !server.needsKey ? (
              <ModelList
                server={server}
                onPull={server.manageable ? () => setPullFrom(server) : undefined}
                onRemove={server.manageable ? (model) => setRemoving({ server, model }) : undefined}
              />
            ) : null}
          </div>
        ))}
      {local && !local.servers.some((server) => server.source !== "everyos") ? (
        <p className="text-xs leading-relaxed text-fg-subtle">{t("aiAgents.local.noServers")}</p>
      ) : null}
      {local?.pulls.length ? (
        <div className="flex flex-col gap-2" aria-label={t("aiAgents.local.downloads")}>
          {local.pulls.map((pull) => (
            <PullProgress key={pull.id} pull={pull} onChanged={reload} />
          ))}
        </div>
      ) : null}
      {setup && local ? (
        <OllamaSetupDialog local={local} onClose={() => setSetup(false)} onStarted={setJob} />
      ) : null}
      {pullFrom ? (
        <PullModelDialog
          server={pullFrom}
          memoryBytes={local?.ollama.memoryBytes ?? null}
          onClose={() => setPullFrom(null)}
          onStarted={reload}
        />
      ) : null}
      {removing ? (
        <DeleteModelDialog
          server={removing.server}
          model={removing.model}
          onClose={() => setRemoving(null)}
          onDeleted={reload}
        />
      ) : null}
    </div>
  );
}

function ModelList({
  server,
  onPull,
  onRemove,
}: {
  server: LocalModelServer;
  onPull?: (() => void) | undefined;
  onRemove?: ((model: string) => void) | undefined;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      {server.models.length ? (
        <ul className="flex flex-col divide-y divide-line rounded-everyos-md border border-line">
          {server.models.map((model) => (
            <li key={model.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{model.id}</span>
              <span className="text-xs text-fg-subtle">
                {[
                  model.parameters,
                  model.quantization,
                  model.size ? formatBytes(model.size, i18n.language) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {onRemove ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("aiAgents.local.deleteModel", { model: model.id })}
                  onClick={() => onRemove(model.id)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-fg-muted">{t("aiAgents.local.noModels")}</p>
      )}
      {onPull ? (
        <Button variant="secondary" size="sm" className="self-start" onClick={onPull}>
          <HardDriveDownload className="size-4" aria-hidden />
          {t("aiAgents.local.download")}
        </Button>
      ) : null}
    </div>
  );
}
