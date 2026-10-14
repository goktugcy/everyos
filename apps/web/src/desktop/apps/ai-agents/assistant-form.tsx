import {
  AI_PROVIDER_URLS,
  type AiAgentKind,
  type AiAgentSettings,
  type AiAgentView,
  type AppJobView,
  type LocalModelServer,
  type LocalModelsView,
} from "@everyos/shared";
import { Check } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Field, PasswordField } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { api } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { formatBytes } from "../../../lib/format.ts";
import { Toggle } from "../../menubar/quick-settings.tsx";

/** Everything the connection and model sections edit, before it becomes an API payload. */
export interface AssistantForm {
  settings: AiAgentSettings;
  gatewayKey: string;
  providerKey: string;
  clearProviderKey: boolean;
}
export function formFor(agent: AiAgentView): AssistantForm {
  return { settings: agent.settings, gatewayKey: "", providerKey: "", clearProviderKey: false };
}

/** Where a direct local chat runs: the EveryOS Ollama, a discovered server or an address. */
export type LocalSource = "everyos" | `server:${string}` | "manual";
export function localSource(settings: AiAgentSettings, local: LocalModelsView | null): LocalSource {
  if (settings.mode === "managed") return "everyos";
  const server = local?.servers.find(
    (entry) =>
      entry.source !== "everyos" && entry.baseUrl === settings.baseUrl.replace(/\/v1\/?$/, ""),
  );
  return server ? `server:${server.id}` : "manual";
}
export function localServer(
  source: LocalSource,
  local: LocalModelsView | null,
): LocalModelServer | null {
  return source === "everyos"
    ? (local?.servers.find((entry) => entry.source === "everyos") ?? null)
    : source.startsWith("server:")
      ? (local?.servers.find((entry) => entry.id === source.slice(7)) ?? null)
      : null;
}

/** The model an EveryOS-installed agent uses. `server:` choices are custom URLs found on the host. */
export type ProviderChoice = "ollama" | "openrouter" | "openai" | "custom" | `server:${string}`;
const isServer = (choice: ProviderChoice): choice is `server:${string}` =>
  choice.startsWith("server:");
export function providerChoice(
  settings: AiAgentSettings,
  local: LocalModelsView | null,
): ProviderChoice {
  if (settings.provider !== "custom") return settings.provider;
  const server = local?.servers.find(
    (entry) => entry.containerUrl && `${entry.containerUrl}/v1` === settings.providerUrl,
  );
  return server ? `server:${server.id}` : "custom";
}
export function applyProvider(
  settings: AiAgentSettings,
  choice: ProviderChoice,
  local: LocalModelsView | null,
): AiAgentSettings {
  if (isServer(choice)) {
    const server = local?.servers.find((entry) => entry.id === choice.slice(7));
    return {
      ...settings,
      provider: "custom",
      providerUrl: server?.containerUrl ? `${server.containerUrl}/v1` : settings.providerUrl,
      model: server?.models.some((model) => model.id === settings.model)
        ? settings.model
        : (server?.models[0]?.id ?? ""),
    };
  }
  if (choice === "custom") return { ...settings, provider: "custom" };
  const everyos = local?.servers.find((entry) => entry.source === "everyos");
  return {
    ...settings,
    provider: choice,
    providerUrl: AI_PROVIDER_URLS[choice],
    model:
      choice === "ollama" && !everyos?.models.some((model) => model.id === settings.model)
        ? (everyos?.models[0]?.id ?? "")
        : settings.model,
  };
}
/** Models the chosen agent provider offers, when EveryOS can list them. */
export function providerModels(choice: ProviderChoice, local: LocalModelsView | null) {
  if (choice === "ollama")
    return local?.servers.find((entry) => entry.source === "everyos")?.models ?? null;
  if (choice.startsWith("server:"))
    return local?.servers.find((entry) => entry.id === choice.slice(7))?.models ?? null;
  return null;
}

export async function saveAssistant(
  kind: AiAgentKind,
  form: AssistantForm,
): Promise<AppJobView | null> {
  const result = await api<{ job: AppJobView | null }>(`/ai-agents/${kind}`, {
    method: "PUT",
    body: {
      ...form.settings,
      // A local chat's model is its API model; managed settings must name one.
      ...(kind === "local" ? { model: form.settings.apiModel } : {}),
      gatewayKey: form.gatewayKey,
      providerKey: form.providerKey,
      clearProviderKey: form.clearProviderKey,
    },
  });
  return result.job;
}

/** A large radio option: icon, title, one-line description and an optional badge. */
export function ChoiceCard({
  selected,
  onSelect,
  icon,
  title,
  description,
  badge,
  disabled,
  testId,
}: {
  selected: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      data-testid={testId}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-everyos-md border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "border-accent bg-accent/10" : "border-line hover:bg-hover/8",
      )}
    >
      {icon ? <span className="mt-0.5 shrink-0 text-accent">{icon}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {title}
          {badge}
        </span>
        {description ? (
          <span className="text-xs leading-relaxed text-fg-muted">{description}</span>
        ) : null}
      </span>
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border",
          selected ? "border-accent bg-accent text-white" : "border-line",
        )}
      >
        {selected ? <Check className="size-3" /> : null}
      </span>
    </button>
  );
}
export function ChoiceGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
      {children}
    </div>
  );
}
export function Badge({
  children,
  tone = "accent",
}: {
  children: ReactNode;
  tone?: "accent" | "muted" | "warning";
}) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "accent" && "bg-accent/15 text-accent",
        tone === "muted" && "bg-hover/10 text-fg-muted",
        tone === "warning" && "bg-warning/15 text-warning",
      )}
    >
      {children}
    </span>
  );
}

/** Pick from the server's models; free text when it lists none or for another name. */
export function ModelPicker({
  label,
  hint,
  models,
  value,
  onChange,
  required = true,
  placeholder,
}: {
  label: string;
  hint?: ReactNode;
  models: ReadonlyArray<{ id: string; size: number | null; parameters: string | null }> | null;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  const { t, i18n } = useTranslation();
  const listed = models?.some((model) => model.id === value) ?? false;
  // A typed name stays typed; otherwise the list appears as soon as the server reports models.
  const [chose, setTyping] = useState(false);
  const typing = chose || !models?.length || (value !== "" && !listed);
  const other = "\u0000other";
  if (models?.length && !typing)
    return (
      <Select
        label={label}
        value={value}
        options={[
          // Nothing is shown as chosen until a model really is.
          ...(value ? [] : [{ value: "", label: t("aiAgents.form.chooseModel") }]),
          ...models.map((model) => ({
            value: model.id,
            label: [
              model.id,
              model.parameters,
              model.size ? formatBytes(model.size, i18n.language) : null,
            ]
              .filter(Boolean)
              .join(" · "),
          })),
          { value: other, label: t("aiAgents.form.otherModel") },
        ]}
        onChange={(next) => {
          if (next === other) {
            setTyping(true);
            onChange("");
          } else onChange(next);
        }}
      />
    );
  return (
    <Field
      required={required}
      label={label}
      value={value}
      maxLength={200}
      placeholder={placeholder}
      hint={hint}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** Tools and step limit for EveryOS-installed agents. */
export function AdvancedFields({
  kind,
  settings,
  onChange,
}: {
  kind: AiAgentKind;
  settings: AiAgentSettings;
  onChange: (settings: AiAgentSettings) => void;
}) {
  const { t } = useTranslation();
  const toolsId = useId();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4 rounded-everyos-md border border-line p-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span id={toolsId} className="text-sm">
            {t("aiAgents.tools")}
          </span>
          <span className="text-xs leading-relaxed text-fg-muted">{t("aiAgents.toolsHint")}</span>
        </div>
        <Toggle
          label={t("aiAgents.tools")}
          checked={settings.tools}
          onCheckedChange={(tools) => onChange({ ...settings, tools })}
        />
      </div>
      {kind === "hermes" ? (
        <Field
          type="number"
          required
          min={1}
          max={100}
          label={t("aiAgents.maxIterations")}
          hint={t("aiAgents.form.maxIterationsHint")}
          value={settings.maxIterations}
          onChange={(event) => onChange({ ...settings, maxIterations: Number(event.target.value) })}
        />
      ) : null}
    </div>
  );
}

/** API key fields: the stored key is never sent back, so an empty field keeps it. */
export function KeyField({
  label,
  stored,
  value,
  onChange,
  required,
  hint,
}: {
  label: string;
  stored: boolean;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  hint?: string;
}) {
  const { t } = useTranslation();
  return (
    <PasswordField
      label={label}
      required={required && !stored}
      value={value}
      autoComplete="new-password"
      onChange={(event) => onChange(event.target.value)}
      hint={stored ? t("aiAgents.form.keyStored") : hint}
    />
  );
}
