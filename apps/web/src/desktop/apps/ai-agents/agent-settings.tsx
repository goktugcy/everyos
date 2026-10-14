import {
  AI_PROVIDERS,
  type AiAgentDiscovery,
  type AiAgentView,
  type AppJobView,
} from "@everyos/shared";
import { MessageCircle, Play, Power, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field, PasswordField } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { api } from "../../../lib/api.ts";
import { desktop } from "../../state/controller.ts";
import { Progress } from "../store/parts.tsx";
import { ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { AiAgentIcon } from "./agent-icon.tsx";
import { useAiAgents } from "./agent-store.ts";

type Action = "install" | "start" | "stop" | "restart" | "retry";
export function AgentSettings({
  agent,
  initialConnection,
  onSaved,
}: {
  agent: AiAgentView;
  initialConnection?: AiAgentDiscovery | undefined;
  onSaved?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(
    initialConnection
      ? {
          ...agent.settings,
          mode: "external" as const,
          baseUrl: initialConnection.baseUrl,
          apiModel: initialConnection.apiModel,
        }
      : agent.settings,
  );
  const [gatewayKey, setGatewayKey] = useState(""),
    [providerKey, setProviderKey] = useState("");
  const [clearProviderKey, setClearProviderKey] = useState(false);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null),
    [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [job, setJob] = useState<AppJobView | null>(null),
    [dismissedJob, setDismissedJob] = useState<string | null>(null);
  const refresh = useAiAgents((state) => state.refresh);
  const changed = useCallback(() => void refresh(), [refresh]);
  const busy = pending || agent.busy;
  const currentJob = job ?? agent.job;
  const managed = draft.mode === "managed";
  const save = async () => {
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api<{ job: AppJobView | null }>(`/ai-agents/${agent.kind}`, {
        method: "PUT",
        body: { ...draft, gatewayKey, providerKey, clearProviderKey },
      });
      setJob(result.job);
      setDismissedJob(null);
      setGatewayKey("");
      setProviderKey("");
      setClearProviderKey(false);
      setSaved(true);
      await refresh();
      onSaved?.();
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  };
  const action = async (action: Action) => {
    setConfirm(null);
    setPending(true);
    setError(null);
    try {
      const result = await api<{ job: AppJobView }>(`/ai-agents/${agent.kind}/actions`, {
        method: "POST",
        body: { action, confirm: agent.kind },
      });
      setJob(result.job);
      setDismissedJob(null);
      await refresh();
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex flex-col gap-5" data-testid={`ai-settings-${agent.kind}`}>
      <div className="glass-inset flex flex-wrap items-center gap-3 rounded-everyos-lg p-4">
        <AiAgentIcon kind={agent.kind} className="size-8 text-accent" />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{t(`aiAgents.names.${agent.kind}`)}</h3>
          <p role="status" className="mt-1 text-xs text-fg-muted">
            {t(agent.busy ? "aiAgents.busy" : `aiAgents.statuses.${agent.status}`)}
          </p>
        </div>
        <SimulatedBadge source={agent.source} />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => desktop.openApp("everyos.agents", { appState: { kind: agent.kind } })}
        >
          <MessageCircle className="size-4" aria-hidden />
          {t("aiAgents.quickChat")}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("aiAgents.testConnection")}
          onClick={changed}
          disabled={pending}
        >
          <RefreshCw className="size-4" aria-hidden />
        </Button>
      </div>
      <ResourceError error={error} onDismiss={() => setError(null)} />
      {saved ? (
        <Alert tone="success" onDismiss={() => setSaved(false)}>
          {t("aiAgents.saved")}
        </Alert>
      ) : null}
      {currentJob && dismissedJob !== currentJob.id ? (
        <Progress
          key={currentJob.id}
          id={currentJob.id}
          onChanged={changed}
          onDismiss={() => setDismissedJob(currentJob.id)}
        />
      ) : null}
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5 disabled:opacity-70">
          <Select
            label={t("aiAgents.mode")}
            value={draft.mode}
            options={[
              { value: "managed", label: t("aiAgents.managed") },
              { value: "external", label: t("aiAgents.external") },
            ]}
            onChange={(mode) => {
              setDraft({ ...draft, mode });
              setSaved(false);
            }}
          />
          {managed ? (
            <>
              <p className="text-xs leading-relaxed text-fg-muted">{t("aiAgents.installHint")}</p>
              <Select
                label={t("aiAgents.provider")}
                value={draft.provider}
                options={AI_PROVIDERS.map((value) => ({
                  value,
                  label: t(`aiAgents.providers.${value}`),
                }))}
                onChange={(provider) => setDraft({ ...draft, provider })}
              />
              {draft.provider === "custom" ? (
                <Field
                  type="url"
                  required
                  label={t("aiAgents.providerUrl")}
                  value={draft.providerUrl}
                  onChange={(event) => setDraft({ ...draft, providerUrl: event.target.value })}
                  hint={t("aiAgents.localHint")}
                />
              ) : null}
              <Field
                required
                label={t("aiAgents.model")}
                value={draft.model}
                maxLength={200}
                placeholder={t("aiAgents.modelPlaceholder")}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              />
              <PasswordField
                label={t("aiAgents.providerKey")}
                value={providerKey}
                autoComplete="new-password"
                onChange={(event) => setProviderKey(event.target.value)}
                hint={t(agent.hasProviderKey ? "aiAgents.keepKey" : "aiAgents.keyHint")}
              />
              {agent.hasProviderKey && draft.provider === "custom" ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={clearProviderKey}
                    onChange={(event) => setClearProviderKey(event.target.checked)}
                  />
                  {t("aiAgents.clearProviderKey")}
                </label>
              ) : null}
              {agent.kind === "hermes" ? (
                <Field
                  type="number"
                  required
                  min={1}
                  max={100}
                  label={t("aiAgents.maxIterations")}
                  value={draft.maxIterations}
                  onChange={(event) =>
                    setDraft({ ...draft, maxIterations: Number(event.target.value) })
                  }
                />
              ) : null}
              <label className="flex items-start gap-3 rounded-everyos-md border border-line p-3 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={draft.tools}
                  onChange={(event) => setDraft({ ...draft, tools: event.target.checked })}
                />
                <span>
                  {t("aiAgents.tools")}
                  <span className="mt-1 block text-xs leading-relaxed text-fg-muted">
                    {t("aiAgents.toolsHint")}
                  </span>
                </span>
              </label>
            </>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-fg-muted">{t("aiAgents.externalHint")}</p>
              <Field
                type="url"
                required
                label={t("aiAgents.baseUrl")}
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
              <Field
                required
                label={t("aiAgents.apiModel")}
                value={draft.apiModel}
                onChange={(event) => setDraft({ ...draft, apiModel: event.target.value })}
              />
              <PasswordField
                label={t("aiAgents.gatewayKey")}
                required={
                  !(
                    agent.hasGatewayKey &&
                    agent.settings.mode === "external" &&
                    agent.settings.baseUrl === draft.baseUrl
                  )
                }
                value={gatewayKey}
                autoComplete="new-password"
                onChange={(event) => setGatewayKey(event.target.value)}
                hint={t(
                  agent.hasGatewayKey && agent.settings.mode === "external"
                    ? "aiAgents.keepKey"
                    : "aiAgents.gatewayKeyHint",
                )}
              />
              <Alert>{t(`aiAgents.externalHelp.${agent.kind}`)}</Alert>
            </>
          )}
          <Button type="submit" loading={pending}>
            {t(managed && agent.app ? "aiAgents.saveAndRestart" : "common.save")}
          </Button>
        </fieldset>
      </form>
      {agent.configured && agent.settings.mode === "managed" ? (
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          {!agent.app ? (
            <Button disabled={busy} onClick={() => setConfirm("install")}>
              <Play className="size-4" aria-hidden />
              {t("aiAgents.install")}
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirm(agent.status === "stopped" ? "start" : "stop")}
              >
                <Power className="size-4" aria-hidden />
                {t(`appStore.actions.${agent.status === "stopped" ? "start" : "stop"}`)}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirm("restart")}>
                {t("appStore.actions.restart")}
              </Button>
              {agent.app.lastError ? (
                <Button variant="secondary" disabled={busy} onClick={() => setConfirm("retry")}>
                  {t("common.retry")}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {confirm ? (
        <Dialog
          open
          onOpenChange={(open) => !open && setConfirm(null)}
          title={t("aiAgents.confirmTitle", {
            action: t(confirm === "install" ? "aiAgents.install" : `appStore.actions.${confirm}`),
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
            <Button onClick={() => void action(confirm)}>{t("common.confirm")}</Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
