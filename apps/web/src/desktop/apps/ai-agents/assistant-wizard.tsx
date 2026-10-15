import {
  AI_AGENT_KINDS,
  type AiAgentKind,
  type AiAgentView,
  type AppJobView,
  type LocalModelServer,
  type LocalModelsView,
} from "@everyos/shared";
import { ArrowLeft, ArrowRight, MessageCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { cn } from "../../../lib/cn.ts";
import { desktop } from "../../state/controller.ts";
import { ResourceError } from "../system/parts.tsx";
import { AiAgentIcon } from "./agent-icon.tsx";
import { useAiAgents } from "./agent-store.ts";
import {
  AdvancedFields,
  applyProvider,
  Badge,
  ChoiceCard,
  ChoiceGroup,
  formFor,
  localServer,
  localSource,
  providerChoice,
  type AssistantForm,
} from "./assistant-form.tsx";
import { JobProgress, saveAndDeploy, StatusPill } from "./assistant-editor.tsx";
import { ConnectionSection, ModelSection } from "./assistant-sections.tsx";
import { BehaviorSection, withBehavior } from "./behavior-section.tsx";
import { OllamaSetupDialog, PullModelDialog } from "./local-models-panel.tsx";

const STEPS = ["type", "source", "model", "finish"] as const;
type Step = (typeof STEPS)[number];

/** Sensible first choices from what is already on this host. */
function initialForm(agent: AiAgentView, local: LocalModelsView | null): AssistantForm {
  const form = formFor(agent);
  if (agent.configured) return form;
  const everyos = local?.servers.find((server) => server.source === "everyos" && server.online);
  if (agent.kind === "local") {
    const found =
      local?.servers.find(
        (server) => server.source !== "everyos" && server.online && server.models.length,
      ) ?? null;
    const server = everyos?.models.length ? everyos : found;
    return {
      ...form,
      settings: {
        ...form.settings,
        mode: server?.source === "everyos" ? "managed" : "external",
        baseUrl: server?.baseUrl ?? form.settings.baseUrl,
        apiModel: server?.models[0]?.id ?? "",
      },
    };
  }
  return everyos?.models.length
    ? { ...form, settings: applyProvider(form.settings, "ollama", local) }
    : form;
}

/** Whether the current step has what the next one needs. */
function stepReady(
  step: Step,
  kind: AiAgentKind,
  agent: AiAgentView,
  form: AssistantForm,
  local: LocalModelsView | null,
) {
  const settings = form.settings;
  if (step === "source") {
    if (kind === "local") {
      const source = localSource(settings, local);
      if (source === "everyos")
        return local?.ollama.app !== null && local?.ollama.app !== undefined;
      if (source === "manual") return /^https?:\/\/\S+$/.test(settings.baseUrl);
      const server = localServer(source, local);
      return (
        Boolean(server?.online) &&
        (!server?.needsKey || Boolean(form.gatewayKey) || agent.hasGatewayKey)
      );
    }
    return (
      settings.mode === "managed" ||
      (/^https?:\/\/\S+$/.test(settings.baseUrl) &&
        (Boolean(form.gatewayKey) || agent.hasGatewayKey))
    );
  }
  if (step === "model") {
    if (kind === "local") return settings.apiModel.trim().length > 0;
    if (settings.mode === "external") return settings.apiModel.trim().length > 0;
    const choice = providerChoice(settings, local);
    const keyed =
      form.providerKey.length > 0 ||
      (agent.hasProviderKey && agent.settings.providerUrl === settings.providerUrl);
    return (
      settings.model.trim().length > 0 &&
      ((choice !== "openrouter" && choice !== "openai") || keyed) &&
      (choice !== "custom" || /^https?:\/\/\S+$/.test(settings.providerUrl))
    );
  }
  return true;
}

/** Step-by-step setup: what, where, which model, then save and check. */
export function AssistantWizard({
  agents,
  local,
  reloadLocal,
  initialKind,
  onClose,
}: {
  agents: AiAgentView[];
  local: LocalModelsView | null;
  reloadLocal: () => void;
  initialKind?: AiAgentKind | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useAiAgents((state) => state.refresh);
  const localFound =
    local?.servers.filter((server) => server.online && server.models.length).length ?? 0;
  const [kind, setKind] = useState<AiAgentKind>(initialKind ?? "local");
  const agent = agents.find((entry) => entry.kind === kind);
  const [forms, setForms] = useState<Partial<Record<AiAgentKind, AssistantForm>>>({});
  const initial = agent ? initialForm(agent, local) : null;
  const form = forms[kind] ?? (initial && kind === "local" ? withBehavior(initial, t) : initial);
  const setForm = (next: AssistantForm) => setForms({ ...forms, [kind]: next });
  const [step, setStep] = useState<Step>(initialKind ? "source" : "type");
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null),
    [job, setJob] = useState<AppJobView | null>(null),
    [done, setDone] = useState(false),
    [setupOllama, setSetupOllama] = useState(false),
    [pullFrom, setPullFrom] = useState<LocalModelServer | null>(null);
  if (!agent || !form) return null;
  const index = STEPS.indexOf(step);
  const managedAgent = kind !== "local" && form.settings.mode === "managed";
  const finish = async () => {
    setPending(true);
    setError(null);
    try {
      setJob(await saveAndDeploy(agent, form));
      setDone(true);
      await refresh();
      reloadLocal();
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  };
  const live = agents.find((entry) => entry.kind === kind) ?? agent;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      className="w-[min(96vw,640px)]"
      title={t("aiAgents.wizard.title")}
      description={t("aiAgents.wizard.progress", {
        current: index + 1,
        total: STEPS.length,
        step: t(`aiAgents.wizard.steps.${step}`),
      })}
    >
      <div className="flex flex-col gap-5" data-testid="assistant-wizard" data-step={step}>
        <ol className="flex gap-1.5" aria-hidden>
          {STEPS.map((entry, position) => (
            <li
              key={entry}
              className={cn(
                "h-1 flex-1 rounded-full",
                position <= index ? "bg-accent" : "bg-hover/15",
              )}
            />
          ))}
        </ol>
        {step === "type" ? (
          <>
            <h3 className="text-base font-semibold">{t("aiAgents.wizard.typeTitle")}</h3>
            <ChoiceGroup label={t("aiAgents.wizard.typeTitle")}>
              {AI_AGENT_KINDS.map((value) => (
                <ChoiceCard
                  key={value}
                  testId={`wizard-kind-${value}`}
                  selected={kind === value}
                  onSelect={() => setKind(value)}
                  icon={<AiAgentIcon kind={value} className="size-6" />}
                  title={t(`aiAgents.names.${value}`)}
                  description={t(`aiAgents.descriptions.${value}`)}
                  badge={
                    value === "local" && localFound ? (
                      <Badge>{t("aiAgents.wizard.localFound", { count: localFound })}</Badge>
                    ) : agents.find((entry) => entry.kind === value)?.configured ? (
                      <Badge tone="muted">{t("aiAgents.wizard.configured")}</Badge>
                    ) : null
                  }
                />
              ))}
            </ChoiceGroup>
          </>
        ) : null}
        {step === "source" ? (
          <>
            <h3 className="text-base font-semibold">
              {t(kind === "local" ? "aiAgents.wizard.sourceLocal" : "aiAgents.wizard.sourceAgent", {
                agent: t(`aiAgents.names.${kind}`),
              })}
            </h3>
            <ConnectionSection
              kind={kind}
              agent={agent}
              form={form}
              setForm={setForm}
              local={local}
              onSetupOllama={() => setSetupOllama(true)}
            />
            <JobProgress job={job} onDismiss={() => setJob(null)} />
          </>
        ) : null}
        {step === "model" ? (
          <>
            <h3 className="text-base font-semibold">
              {t(
                kind === "local" || form.settings.mode === "external"
                  ? "aiAgents.wizard.modelTitle"
                  : "aiAgents.wizard.providerTitle",
              )}
            </h3>
            <ModelSection
              kind={kind}
              agent={agent}
              form={form}
              setForm={setForm}
              local={local}
              onPull={setPullFrom}
            />
            {kind === "local" ? (
              <details className="rounded-everyos-md border border-line p-3">
                <summary className="cursor-pointer text-sm">
                  {t("aiAgents.behavior.wizardTitle")}
                </summary>
                <div className="mt-3">
                  <BehaviorSection
                    agent={agent}
                    form={form}
                    setForm={setForm}
                    local={local}
                    onPull={setPullFrom}
                    preview={false}
                  />
                </div>
              </details>
            ) : null}
            {local?.pulls.some((pull) => pull.state === "running") ? (
              <Alert>{t("aiAgents.wizard.pullRunning")}</Alert>
            ) : null}
            {managedAgent ? (
              <details className="rounded-everyos-md border border-line p-3">
                <summary className="cursor-pointer text-sm">
                  {t("aiAgents.form.sections.advanced")}
                </summary>
                <div className="mt-3">
                  <AdvancedFields
                    kind={kind}
                    settings={form.settings}
                    onChange={(settings) => setForm({ ...form, settings })}
                  />
                </div>
              </details>
            ) : null}
          </>
        ) : null}
        {step === "finish" ? (
          <>
            <h3 className="text-base font-semibold">{t("aiAgents.wizard.finishTitle")}</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-everyos-md border border-line p-3 text-sm">
              <dt className="text-fg-muted">{t("aiAgents.wizard.summary.assistant")}</dt>
              <dd>{t(`aiAgents.names.${kind}`)}</dd>
              <dt className="text-fg-muted">{t("aiAgents.wizard.summary.source")}</dt>
              <dd className="break-all">
                {kind === "local"
                  ? (localServer(localSource(form.settings, local), local)?.name ??
                    form.settings.baseUrl)
                  : t(managedAgent ? "aiAgents.managed" : "aiAgents.external")}
              </dd>
              <dt className="text-fg-muted">{t("aiAgents.wizard.summary.model")}</dt>
              <dd className="break-all">
                {kind === "local" || !managedAgent ? form.settings.apiModel : form.settings.model}
              </dd>
            </dl>
            {managedAgent && !agent.app ? (
              <p className="text-xs leading-relaxed text-fg-muted">
                {t("aiAgents.installConfirm")}
              </p>
            ) : null}
            <JobProgress job={job} onDismiss={() => setJob(null)} />
            {done ? (
              <div className="flex flex-wrap items-center gap-3 rounded-everyos-md border border-line p-3">
                <span className="text-sm">{t("aiAgents.wizard.statusNow")}</span>
                <StatusPill agent={live} />
                <span className="flex-1" />
                <Button
                  size="sm"
                  disabled={live.status !== "running"}
                  onClick={() => {
                    onClose();
                    desktop.openApp("everyos.agents", { appState: { kind } });
                  }}
                >
                  <MessageCircle className="size-4" aria-hidden />
                  {t("aiAgents.quickChat")}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
        <ResourceError error={error} onDismiss={() => setError(null)} />
        <div className="flex justify-between gap-2 border-t border-line pt-4">
          <Button
            variant="ghost"
            disabled={
              pending || index === 0 || (initialKind !== undefined && step === "source") || done
            }
            onClick={() => setStep(STEPS[index - 1]!)}
          >
            <ArrowLeft className="size-4" aria-hidden />
            {t("aiAgents.wizard.back")}
          </Button>
          {step === "finish" ? (
            done ? (
              <Button variant="secondary" onClick={onClose}>
                {t("aiAgents.wizard.close")}
              </Button>
            ) : (
              <Button loading={pending} onClick={() => void finish()} data-testid="wizard-finish">
                {t(managedAgent && !agent.app ? "aiAgents.form.saveAndInstall" : "common.save")}
              </Button>
            )
          ) : (
            <Button
              disabled={!stepReady(step, kind, agent, form, local)}
              onClick={() => setStep(STEPS[index + 1]!)}
              data-testid="wizard-next"
            >
              {t("aiAgents.wizard.next")}
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>
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
