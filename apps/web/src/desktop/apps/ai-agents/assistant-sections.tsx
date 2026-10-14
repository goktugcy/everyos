import type { AiAgentKind, AiAgentView, LocalModelServer, LocalModelsView } from "@everyos/shared";
import { Cloud, Globe, HardDriveDownload, Link2, Server, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { AiAgentIcon } from "./agent-icon.tsx";
import {
  applyProvider,
  Badge,
  ChoiceCard,
  ChoiceGroup,
  KeyField,
  localServer,
  localSource,
  ModelPicker,
  providerChoice,
  providerModels,
  type AssistantForm,
  type LocalSource,
  type ProviderChoice,
} from "./assistant-form.tsx";

interface SectionProps {
  kind: AiAgentKind;
  agent: AiAgentView;
  form: AssistantForm;
  setForm: (form: AssistantForm) => void;
  local: LocalModelsView | null;
}

/** One line about a server: where it runs, its address and its models. */
export function ServerSummary({ server }: { server: LocalModelServer }) {
  const { t } = useTranslation();
  return (
    <>
      {t(`aiAgents.local.serverSources.${server.source}`)} · {server.baseUrl.replace("http://", "")}
      {server.online ? ` · ${t("aiAgents.local.modelCount", { count: server.models.length })}` : ""}
    </>
  );
}
function serverBadges(server: LocalModelServer) {
  return (
    <>
      {!server.online ? <ServerBadge state="offline" /> : null}
      {server.needsKey ? <ServerBadge state="needsKey" /> : null}
    </>
  );
}
function ServerBadge({ state }: { state: "offline" | "needsKey" }) {
  const { t } = useTranslation();
  return <Badge tone="warning">{t(`aiAgents.local.badges.${state}`)}</Badge>;
}

/** Where the assistant runs. */
export function ConnectionSection({
  kind,
  agent,
  form,
  setForm,
  local,
  onSetupOllama,
}: SectionProps & { onSetupOllama: () => void }) {
  const { t } = useTranslation();
  const settings = form.settings;
  if (kind === "local") {
    const source = localSource(settings, local);
    const everyos = local?.servers.find((server) => server.source === "everyos") ?? null;
    const others = local?.servers.filter((server) => server.source !== "everyos") ?? [];
    const select = (next: LocalSource) => {
      const server = localServer(next, local);
      setForm({
        ...form,
        gatewayKey: "",
        settings: {
          ...settings,
          mode: next === "everyos" ? "managed" : "external",
          baseUrl:
            server?.baseUrl ?? (next === "manual" && source !== "manual" ? "" : settings.baseUrl),
          apiModel: server?.models.some((model) => model.id === settings.apiModel)
            ? settings.apiModel
            : (server?.models[0]?.id ?? (next === "manual" ? settings.apiModel : "")),
        },
      });
    };
    return (
      <div className="flex flex-col gap-3">
        <ChoiceGroup label={t("aiAgents.form.localSource")}>
          {others.map((server) => (
            <ChoiceCard
              key={server.id}
              testId={`local-source-${server.id}`}
              selected={source === `server:${server.id}`}
              onSelect={() => select(`server:${server.id}`)}
              icon={<Server className="size-5" />}
              title={server.name}
              description={<ServerSummary server={server} />}
              badge={serverBadges(server)}
            />
          ))}
          <ChoiceCard
            testId="local-source-everyos"
            selected={source === "everyos"}
            onSelect={() => select("everyos")}
            icon={<AiAgentIcon kind="local" className="size-5" />}
            title={t("aiAgents.local.everyos")}
            description={
              everyos
                ? t("aiAgents.form.everyosInstalled", { count: everyos.models.length })
                : t("aiAgents.form.everyosMissing")
            }
            badge={!everyos ? <Badge tone="muted">{t("aiAgents.local.notInstalled")}</Badge> : null}
          />
          <ChoiceCard
            testId="local-source-manual"
            selected={source === "manual"}
            onSelect={() => select("manual")}
            icon={<Link2 className="size-5" />}
            title={t("aiAgents.form.manualServer")}
            description={t("aiAgents.form.manualServerHint")}
          />
        </ChoiceGroup>
        {source === "everyos" && !local?.ollama.app ? (
          <Alert tone="info" title={t("aiAgents.local.installTitle")}>
            <p>{t("aiAgents.local.installPitch")}</p>
            <Button className="mt-3" size="sm" onClick={onSetupOllama}>
              <HardDriveDownload className="size-4" aria-hidden />
              {t("aiAgents.local.install")}
            </Button>
          </Alert>
        ) : null}
        {source === "manual" ? (
          <>
            <Field
              type="url"
              required
              label={t("aiAgents.form.serverUrl")}
              hint={t("aiAgents.form.serverUrlHint")}
              placeholder="http://127.0.0.1:11434"
              value={settings.baseUrl}
              onChange={(event) =>
                setForm({ ...form, settings: { ...settings, baseUrl: event.target.value } })
              }
            />
            <KeyField
              label={t("aiAgents.form.serverKey")}
              stored={agent.hasGatewayKey && agent.settings.baseUrl === settings.baseUrl}
              value={form.gatewayKey}
              onChange={(gatewayKey) => setForm({ ...form, gatewayKey })}
              hint={t("aiAgents.form.serverKeyHint")}
            />
          </>
        ) : source.startsWith("server:") && localServer(source, local)?.needsKey ? (
          <KeyField
            label={t("aiAgents.form.serverKey")}
            stored={agent.hasGatewayKey && agent.settings.baseUrl === settings.baseUrl}
            value={form.gatewayKey}
            onChange={(gatewayKey) => setForm({ ...form, gatewayKey })}
            required
          />
        ) : null}
      </div>
    );
  }
  const managed = settings.mode === "managed";
  return (
    <div className="flex flex-col gap-3">
      <ChoiceGroup label={t("aiAgents.mode")}>
        <ChoiceCard
          testId="agent-mode-managed"
          selected={managed}
          onSelect={() => setForm({ ...form, settings: { ...settings, mode: "managed" } })}
          icon={<Sparkles className="size-5" />}
          title={t("aiAgents.managed")}
          description={t("aiAgents.form.managedHint")}
          badge={<Badge>{t("aiAgents.form.recommended")}</Badge>}
        />
        <ChoiceCard
          testId="agent-mode-external"
          selected={!managed}
          onSelect={() => setForm({ ...form, settings: { ...settings, mode: "external" } })}
          icon={<Link2 className="size-5" />}
          title={t("aiAgents.external")}
          description={t("aiAgents.form.externalHint")}
        />
      </ChoiceGroup>
      {!managed ? (
        <>
          <Field
            type="url"
            required
            label={t("aiAgents.baseUrl")}
            hint={t("aiAgents.form.agentUrlHint")}
            value={settings.baseUrl}
            onChange={(event) =>
              setForm({ ...form, settings: { ...settings, baseUrl: event.target.value } })
            }
          />
          <KeyField
            label={t("aiAgents.gatewayKey")}
            stored={
              agent.hasGatewayKey &&
              agent.settings.mode === "external" &&
              agent.settings.baseUrl === settings.baseUrl
            }
            value={form.gatewayKey}
            onChange={(gatewayKey) => setForm({ ...form, gatewayKey })}
            required
            hint={t("aiAgents.gatewayKeyHint")}
          />
          <Alert>{t(`aiAgents.externalHelp.${kind}`)}</Alert>
        </>
      ) : null}
    </div>
  );
}

/** Which model the assistant uses. */
export function ModelSection({
  kind,
  agent,
  form,
  setForm,
  local,
  onPull,
}: SectionProps & { onPull: (server: LocalModelServer) => void }) {
  const { t } = useTranslation();
  const settings = form.settings;
  if (kind === "local") {
    const server = localServer(localSource(settings, local), local);
    return (
      <div className="flex flex-col gap-3">
        {server && !server.online ? (
          <Alert tone="warning">{t("aiAgents.form.serverOffline")}</Alert>
        ) : null}
        <ModelPicker
          label={t("aiAgents.form.model")}
          hint={server?.models.length ? undefined : t("aiAgents.form.modelTyped")}
          models={server?.models ?? null}
          value={settings.apiModel}
          placeholder="qwen3:4b"
          onChange={(apiModel) => setForm({ ...form, settings: { ...settings, apiModel } })}
        />
        {server?.manageable && server.online ? (
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => onPull(server)}
          >
            <HardDriveDownload className="size-4" aria-hidden />
            {t("aiAgents.local.download")}
          </Button>
        ) : null}
      </div>
    );
  }
  if (settings.mode === "external")
    return (
      <Field
        required
        label={t("aiAgents.apiModel")}
        hint={t("aiAgents.form.apiModelHint")}
        value={settings.apiModel}
        onChange={(event) =>
          setForm({ ...form, settings: { ...settings, apiModel: event.target.value } })
        }
      />
    );
  const choice = providerChoice(settings, local);
  const everyos = local?.servers.find((server) => server.source === "everyos") ?? null;
  const hostServers = local?.servers.filter((server) => server.source !== "everyos") ?? [];
  const select = (next: ProviderChoice) =>
    setForm({ ...form, settings: applyProvider(settings, next, local) });
  const models = providerModels(choice, local);
  const cloud = choice === "openrouter" || choice === "openai";
  return (
    <div className="flex flex-col gap-3">
      <ChoiceGroup label={t("aiAgents.provider")}>
        <ChoiceCard
          testId="provider-ollama"
          selected={choice === "ollama"}
          onSelect={() => select("ollama")}
          disabled={!everyos}
          icon={<AiAgentIcon kind="local" className="size-5" />}
          title={t("aiAgents.providers.ollama")}
          description={
            everyos
              ? t("aiAgents.form.providerOllamaHint", { count: everyos.models.length })
              : t("aiAgents.form.providerOllamaMissing")
          }
          badge={everyos ? <Badge>{t("aiAgents.form.private")}</Badge> : null}
        />
        {hostServers.map((server) => (
          <ChoiceCard
            key={server.id}
            testId={`provider-server-${server.id}`}
            selected={choice === `server:${server.id}`}
            onSelect={() => select(`server:${server.id}`)}
            disabled={!server.containerUrl}
            icon={<Server className="size-5" />}
            title={server.name}
            description={
              server.containerUrl ? (
                <ServerSummary server={server} />
              ) : (
                t(`aiAgents.local.access.${server.containerAccess}`)
              )
            }
            badge={serverBadges(server)}
          />
        ))}
        <ChoiceCard
          testId="provider-openrouter"
          selected={choice === "openrouter"}
          onSelect={() => select("openrouter")}
          icon={<Cloud className="size-5" />}
          title={t("aiAgents.providers.openrouter")}
          description={t("aiAgents.form.providerCloudHint")}
        />
        <ChoiceCard
          testId="provider-openai"
          selected={choice === "openai"}
          onSelect={() => select("openai")}
          icon={<Cloud className="size-5" />}
          title={t("aiAgents.providers.openai")}
          description={t("aiAgents.form.providerCloudHint")}
        />
        <ChoiceCard
          testId="provider-custom"
          selected={choice === "custom"}
          onSelect={() => select("custom")}
          icon={<Globe className="size-5" />}
          title={t("aiAgents.providers.custom")}
          description={t("aiAgents.localHint")}
        />
      </ChoiceGroup>
      {choice === "custom" ? (
        <Field
          type="url"
          required
          label={t("aiAgents.providerUrl")}
          value={settings.providerUrl}
          placeholder="http://192.168.1.10:11434/v1"
          onChange={(event) =>
            setForm({ ...form, settings: { ...settings, providerUrl: event.target.value } })
          }
        />
      ) : null}
      <ModelPicker
        key={choice}
        label={t("aiAgents.form.model")}
        hint={
          models ? undefined : t(cloud ? "aiAgents.modelPlaceholder" : "aiAgents.form.modelTyped")
        }
        models={models}
        value={settings.model}
        placeholder={cloud ? "provider/model-name" : "qwen3:4b"}
        onChange={(model) => setForm({ ...form, settings: { ...settings, model } })}
      />
      {cloud || choice === "custom" ? (
        <KeyField
          label={t("aiAgents.providerKey")}
          stored={agent.hasProviderKey && agent.settings.providerUrl === settings.providerUrl}
          value={form.providerKey}
          onChange={(providerKey) => setForm({ ...form, providerKey })}
          required={cloud}
          hint={t(cloud ? "aiAgents.form.providerKeyHint" : "aiAgents.keyHint")}
        />
      ) : null}
      {choice === "custom" && agent.hasProviderKey ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.clearProviderKey}
            onChange={(event) => setForm({ ...form, clearProviderKey: event.target.checked })}
          />
          {t("aiAgents.clearProviderKey")}
        </label>
      ) : null}
    </div>
  );
}
