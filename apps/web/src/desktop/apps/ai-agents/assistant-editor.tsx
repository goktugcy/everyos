import type {
  AiAgentDiscovery,
  AiAgentView,
  AppJobView,
  LocalModelServer,
  LocalModelsView,
} from "@everyos/shared";
import { MessageCircle, Play, Power, RefreshCw } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { api } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { desktop } from "../../state/controller.ts";
import { Progress } from "../store/parts.tsx";
import { ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { AiAgentIcon } from "./agent-icon.tsx";
import { useAiAgents } from "./agent-store.ts";
import { AdvancedFields, formFor, saveAssistant, type AssistantForm } from "./assistant-form.tsx";
import { ConnectionSection, ModelSection } from "./assistant-sections.tsx";
import { BehaviorSection, withBehavior } from "./behavior-section.tsx";
import { OllamaSetupDialog, PullModelDialog } from "./local-models-panel.tsx";

/** Status colors shared by cards, the editor and the wizard. */
export function StatusPill({ agent }: { agent: AiAgentView }) {
  const { t } = useTranslation();
  const tone = agent.busy
    ? "warning"
    : agent.status === "running"
      ? "success"
      : agent.status === "starting"
        ? "warning"
        : agent.status === "unconfigured" ||
            agent.status === "not-installed" ||
            agent.status === "stopped" ||
            agent.status === "unknown"
          ? "muted"
          : "danger";
  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs",
        tone === "success" && "bg-success/15 text-success",
        tone === "warning" && "bg-warning/15 text-warning",
        tone === "danger" && "bg-danger/15 text-danger",
        tone === "muted" && "bg-hover/10 text-fg-muted",
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {t(agent.busy ? "aiAgents.busy" : `aiAgents.statuses.${agent.status}`)}
    </span>
  );
}

/**
 * Saves the form, then installs an EveryOS-managed agent that is not installed yet. The
 * returned job (install or reconfiguration) is shown by {@link JobProgress}.
 */
export async function saveAndDeploy(
  agent: AiAgentView,
  form: AssistantForm,
): Promise<AppJobView | null> {
  const job = await saveAssistant(agent.kind, form);
  if (job || agent.kind === "local" || form.settings.mode !== "managed" || agent.app) return job;
  const result = await api<{ job: AppJobView }>(`/ai-agents/${agent.kind}/actions`, {
    method: "POST",
    body: { action: "install", confirm: agent.kind },
  });
  return result.job;
}

export function JobProgress({ job, onDismiss }: { job: AppJobView | null; onDismiss: () => void }) {
  const refresh = useAiAgents((state) => state.refresh);
  const changed = useCallback(() => void refresh(), [refresh]);
  return job ? (
    <Progress key={job.id} id={job.id} onChanged={changed} onDismiss={onDismiss} />
  ) : null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{title}</h3>
      {children}
    </section>
  );
}

type Action = "install" | "start" | "stop" | "restart" | "retry";

/** Connection, model and advanced settings of one configured assistant. */
export function AssistantEditor({
  agent,
  local,
  reloadLocal,
  initialConnection,
  onClose,
}: {
  agent: AiAgentView;
  local: LocalModelsView | null;
  reloadLocal: () => void;
  initialConnection?: AiAgentDiscovery | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useAiAgents((state) => state.refresh);
  const [form, setForm] = useState<AssistantForm>(() => {
    const base = agent.kind === "local" ? withBehavior(formFor(agent), t) : formFor(agent);
    return initialConnection
      ? {
          ...base,
          settings: {
            ...base.settings,
            mode: "external",
            baseUrl: initialConnection.baseUrl,
            apiModel: initialConnection.apiModel,
          },
        }
      : base;
  });
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null),
    [saved, setSaved] = useState(false),
    [job, setJob] = useState<AppJobView | null>(null),
    [confirm, setConfirm] = useState<Action | null>(null),
    [setupOllama, setSetupOllama] = useState(false),
    [pullFrom, setPullFrom] = useState<LocalModelServer | null>(null);
  const managedAgent = agent.kind !== "local" && form.settings.mode === "managed";
  const busy = pending || agent.busy;
  const save = async () => {
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      setJob(await saveAndDeploy(agent, form));
      setForm({ ...form, gatewayKey: "", providerKey: "", clearProviderKey: false });
      setSaved(true);
      await refresh();
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  };
  const control = async (action: Exclude<Action, "install">) => {
    setConfirm(null);
    setPending(true);
    setError(null);
    try {
      const result = await api<{ job: AppJobView }>(`/ai-agents/${agent.kind}/actions`, {
        method: "POST",
        body: { action, confirm: agent.kind },
      });
      setJob(result.job);
      await refresh();
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
      className="w-[min(96vw,680px)]"
      title={
        <span className="flex items-center gap-2">
          <AiAgentIcon kind={agent.kind} className="size-5 text-accent" />
          {t(`aiAgents.names.${agent.kind}`)}
        </span>
      }
      description={t(`aiAgents.descriptions.${agent.kind}`)}
    >
      <div className="flex flex-col gap-6" data-testid={`ai-settings-${agent.kind}`}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill agent={agent} />
          <SimulatedBadge source={agent.source} />
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => void refresh()}
            data-testid="ai-test-connection"
          >
            <RefreshCw className="size-4" aria-hidden />
            {t("aiAgents.testConnection")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={agent.status !== "running"}
            onClick={() => {
              onClose();
              desktop.openApp("everyos.agents", { appState: { kind: agent.kind } });
            }}
          >
            <MessageCircle className="size-4" aria-hidden />
            {t("aiAgents.quickChat")}
          </Button>
        </div>
        <ResourceError error={error} onDismiss={() => setError(null)} />
        {saved ? (
          <Alert tone="success" onDismiss={() => setSaved(false)}>
            {t("aiAgents.saved")}
          </Alert>
        ) : null}
        <JobProgress job={job ?? agent.job} onDismiss={() => setJob(null)} />
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            // Installing downloads and starts a container: confirm it explicitly.
            if (managedAgent && !agent.app) setConfirm("install");
            else void save();
          }}
        >
          <fieldset disabled={busy} className="flex min-w-0 flex-col gap-6 disabled:opacity-70">
            <Section title={t("aiAgents.form.sections.connection")}>
              <ConnectionSection
                kind={agent.kind}
                agent={agent}
                form={form}
                setForm={setForm}
                local={local}
                onSetupOllama={() => setSetupOllama(true)}
              />
            </Section>
            <Section title={t("aiAgents.form.sections.model")}>
              <ModelSection
                kind={agent.kind}
                agent={agent}
                form={form}
                setForm={setForm}
                local={local}
                onPull={setPullFrom}
              />
            </Section>
            {agent.kind === "local" ? (
              <Section title={t("aiAgents.form.sections.behavior")}>
                <BehaviorSection
                  agent={agent}
                  form={form}
                  setForm={setForm}
                  local={local}
                  onPull={setPullFrom}
                />
              </Section>
            ) : null}
            {managedAgent ? (
              <Section title={t("aiAgents.form.sections.advanced")}>
                <AdvancedFields
                  kind={agent.kind}
                  settings={form.settings}
                  onChange={(settings) => setForm({ ...form, settings })}
                />
              </Section>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              {managedAgent && agent.app ? (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setConfirm(agent.status === "stopped" ? "start" : "stop")}
                  >
                    <Power className="size-4" aria-hidden />
                    {t(`appStore.actions.${agent.status === "stopped" ? "start" : "stop"}`)}
                  </Button>
                  {agent.app.lastError ? (
                    <Button type="button" variant="secondary" onClick={() => setConfirm("retry")}>
                      {t("common.retry")}
                    </Button>
                  ) : null}
                </>
              ) : null}
              <Button type="submit" loading={pending} data-testid="ai-settings-save">
                {managedAgent && !agent.app ? <Play className="size-4" aria-hidden /> : null}
                {t(
                  managedAgent
                    ? agent.app
                      ? "aiAgents.saveAndRestart"
                      : "aiAgents.form.saveAndInstall"
                    : "common.save",
                )}
              </Button>
            </div>
          </fieldset>
        </form>
      </div>
      {confirm ? (
        <Dialog
          open
          onOpenChange={(open) => !open && setConfirm(null)}
          title={t("aiAgents.confirmTitle", {
            action: t(
              confirm === "install"
                ? "aiAgents.form.saveAndInstall"
                : `appStore.actions.${confirm}`,
            ),
            agent: t(`aiAgents.names.${agent.kind}`),
          })}
        >
          <p className="text-sm leading-relaxed text-fg-muted">
            {t(confirm === "install" ? "aiAgents.installConfirm" : "aiAgents.controlConfirm")}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (confirm === "install") {
                  setConfirm(null);
                  void save();
                } else void control(confirm);
              }}
            >
              {t("common.confirm")}
            </Button>
          </div>
        </Dialog>
      ) : null}
      {setupOllama && local ? (
        <OllamaSetupDialog
          local={local}
          onClose={() => setSetupOllama(false)}
          onStarted={(started) => {
            setJob(started);
            reloadLocal();
          }}
        />
      ) : null}
      {pullFrom ? (
        <PullModelDialog
          server={pullFrom}
          memoryBytes={local?.ollama.memoryBytes ?? null}
          onClose={() => setPullFrom(null)}
          onStarted={reloadLocal}
        />
      ) : null}
    </Dialog>
  );
}
