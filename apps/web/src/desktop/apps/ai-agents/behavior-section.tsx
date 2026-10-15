import {
  DEFAULT_LOCAL_BEHAVIOR,
  LOCAL_LANGUAGES,
  LOCAL_LENGTHS,
  LOCAL_MEMORY,
  LOCAL_PRESETS,
  type AiAgentView,
  type LocalBehavior,
  type LocalModelServer,
  type LocalModelsView,
  type LocalPreset,
} from "@everyos/shared";
import type { TFunction } from "i18next";
import { HardDriveDownload, Play, RotateCcw, Square } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { Slider } from "../../../components/ui/slider.tsx";
import { inputClassName } from "../../../components/ui/field.tsx";
import { postApiEvents } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { ResourceError } from "../system/parts.tsx";
import { localServer, localSource, type AssistantForm } from "./assistant-form.tsx";
import { chatError, streamError } from "./chat-errors.ts";

/** Instructions written in the interface language, so the model is addressed in it too. */
export function presetBehavior(t: TFunction, preset: Exclude<LocalPreset, "custom">) {
  return { preset, instructions: t(`aiAgents.behavior.presetTexts.${preset}`) };
}
/** A local form always carries a behavior; older settings get the default assistant. */
export function withBehavior(form: AssistantForm, t: TFunction): AssistantForm {
  return form.settings.behavior
    ? form
    : {
        ...form,
        settings: {
          ...form.settings,
          behavior: { ...DEFAULT_LOCAL_BEHAVIOR, ...presetBehavior(t, "assistant") },
        },
      };
}

/** `3.1B` → 3.1e9, `751.63M` → 7.5e8. */
function parameterCount(value: string | null): number | null {
  const match = /^([\d.]+)\s*([KMBT])$/i.exec(value?.trim() ?? "");
  if (!match) return null;
  const scale: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return Number(match[1]) * scale[match[2]!.toUpperCase()]!;
}

function level(value: number, labels: readonly string[]): string {
  return labels[Math.min(labels.length - 1, Math.floor((value / 101) * labels.length))]!;
}

/** How the local model answers: instructions, language, creativity, length, memory, repetition. */
export function BehaviorSection({
  agent,
  form,
  setForm,
  local,
  onPull,
  preview = true,
}: {
  agent: AiAgentView;
  form: AssistantForm;
  setForm: (form: AssistantForm) => void;
  local: LocalModelsView | null;
  onPull: (server: LocalModelServer) => void;
  preview?: boolean;
}) {
  const { t } = useTranslation();
  const instructionsId = useId();
  const behavior = withBehavior(form, t).settings.behavior!;
  const update = (patch: Partial<LocalBehavior>) =>
    setForm({ ...form, settings: { ...form.settings, behavior: { ...behavior, ...patch } } });
  const server = localServer(localSource(form.settings, local), local);
  const model = server?.models.find((entry) => entry.id === form.settings.apiModel);
  const parameters = parameterCount(model?.parameters ?? null);
  return (
    <div className="flex flex-col gap-5" data-testid="local-behavior">
      {parameters !== null && parameters < 4e9 ? (
        <Alert tone="warning" title={t("aiAgents.behavior.smallModelTitle")}>
          <p>
            {t("aiAgents.behavior.smallModel", {
              model: model!.id,
              size: model!.parameters,
            })}
          </p>
          {server?.manageable && server.online ? (
            <Button className="mt-3" size="sm" variant="secondary" onClick={() => onPull(server)}>
              <HardDriveDownload className="size-4" aria-hidden />
              {t("aiAgents.behavior.betterModel")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2">
        <span className="text-sm text-fg-muted">{t("aiAgents.behavior.persona")}</span>
        <div
          role="radiogroup"
          aria-label={t("aiAgents.behavior.persona")}
          className="flex flex-wrap gap-2"
        >
          {LOCAL_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={behavior.preset === preset}
              data-testid={`behavior-preset-${preset}`}
              onClick={() =>
                preset === "custom" ? update({ preset }) : update(presetBehavior(t, preset))
              }
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                behavior.preset === preset
                  ? "border-accent bg-accent/15 text-fg"
                  : "border-line text-fg-muted hover:bg-hover/8",
              )}
            >
              {t(`aiAgents.behavior.presets.${preset}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={instructionsId} className="text-sm text-fg-muted">
          {t("aiAgents.behavior.instructions")}
        </label>
        <textarea
          id={instructionsId}
          rows={4}
          maxLength={4000}
          value={behavior.instructions}
          placeholder={t("aiAgents.behavior.presetTexts.assistant")}
          onChange={(event) => update({ instructions: event.target.value, preset: "custom" })}
          className={cn(inputClassName, "min-h-24 resize-y py-2 leading-relaxed")}
        />
        <span className="text-xs leading-relaxed text-fg-subtle">
          {t("aiAgents.behavior.instructionsHint")}
        </span>
      </div>
      <Select
        label={t("aiAgents.behavior.language")}
        value={behavior.language}
        options={LOCAL_LANGUAGES.map((value) => ({
          value,
          label: t(`aiAgents.behavior.languages.${value}`),
        }))}
        onChange={(language) => update({ language })}
      />
      <Slider
        label={t("aiAgents.behavior.creativity")}
        value={behavior.creativity}
        min={0}
        max={100}
        step={5}
        format={(value) =>
          level(value, [
            t("aiAgents.behavior.creativityLevels.consistent"),
            t("aiAgents.behavior.creativityLevels.balanced"),
            t("aiAgents.behavior.creativityLevels.creative"),
          ])
        }
        hint={t("aiAgents.behavior.creativityHint")}
        onChange={(creativity) => update({ creativity })}
      />
      <div className="flex flex-col gap-2">
        <span className="text-sm text-fg-muted">{t("aiAgents.behavior.length")}</span>
        <div
          role="radiogroup"
          aria-label={t("aiAgents.behavior.length")}
          className="grid grid-cols-3 gap-1 rounded-everyos-md border border-line p-1"
        >
          {LOCAL_LENGTHS.map((length) => (
            <button
              key={length}
              type="button"
              role="radio"
              aria-checked={behavior.length === length}
              onClick={() => update({ length })}
              className={cn(
                "rounded-everyos-sm px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent",
                behavior.length === length
                  ? "bg-accent/20 text-fg"
                  : "text-fg-muted hover:bg-hover/8",
              )}
            >
              {t(`aiAgents.behavior.lengths.${length}`)}
            </button>
          ))}
        </div>
      </div>
      <Select
        label={t("aiAgents.behavior.memory")}
        value={behavior.memory}
        options={LOCAL_MEMORY.map((value) => ({
          value,
          label: t(`aiAgents.behavior.memories.${value}`),
        }))}
        onChange={(memory) => update({ memory })}
      />
      <p className="-mt-3 text-xs leading-relaxed text-fg-subtle">
        {t("aiAgents.behavior.memoryHint")}
      </p>
      <Slider
        label={t("aiAgents.behavior.repetition")}
        value={behavior.repetition}
        min={0}
        max={100}
        step={5}
        format={(value) =>
          value === 0
            ? t("aiAgents.behavior.repetitionLevels.off")
            : level(value, [
                t("aiAgents.behavior.repetitionLevels.light"),
                t("aiAgents.behavior.repetitionLevels.medium"),
                t("aiAgents.behavior.repetitionLevels.strong"),
              ])
        }
        hint={t("aiAgents.behavior.repetitionHint")}
        onChange={(repetition) => update({ repetition })}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() =>
          setForm({
            ...form,
            settings: {
              ...form.settings,
              behavior: { ...DEFAULT_LOCAL_BEHAVIOR, ...presetBehavior(t, "assistant") },
            },
          })
        }
      >
        <RotateCcw className="size-4" aria-hidden />
        {t("aiAgents.behavior.reset")}
      </Button>
      {preview ? <BehaviorPreview agent={agent} behavior={behavior} /> : null}
    </div>
  );
}

/** Tries the unsaved behavior on the saved model; nothing is kept. */
function BehaviorPreview({ agent, behavior }: { agent: AiAgentView; behavior: LocalBehavior }) {
  const { t } = useTranslation();
  const promptId = useId();
  const [prompt, setPrompt] = useState(() => t("aiAgents.behavior.samplePrompt"));
  const [answer, setAnswer] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  const request = useRef<AbortController | null>(null);
  const ready = agent.configured && agent.status === "running";
  const run = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    setAnswer("");
    try {
      await postApiEvents(
        "/ai-agents/local/preview",
        { behavior, prompt: prompt.trim() },
        controller.signal,
        (event, raw) => {
          const data = raw as { text?: unknown; code?: unknown; message?: unknown };
          if (event === "delta" && typeof data.text === "string") {
            const text = data.text;
            setAnswer((old) => old + text);
          }
          if (event === "error") throw streamError(data);
        },
      );
    } catch (error) {
      if (!controller.signal.aborted) setError(error);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  };
  const failure = error ? chatError(t, "local", error) : null;
  return (
    <section
      className="flex flex-col gap-3 rounded-everyos-md border border-line p-3"
      aria-label={t("aiAgents.behavior.previewTitle")}
      data-testid="behavior-preview"
    >
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-semibold">{t("aiAgents.behavior.previewTitle")}</h4>
        <p className="text-xs leading-relaxed text-fg-muted">
          {t(ready ? "aiAgents.behavior.previewHint" : "aiAgents.behavior.previewUnavailable")}
        </p>
      </div>
      <label htmlFor={promptId} className="sr-only">
        {t("aiAgents.behavior.previewPrompt")}
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id={promptId}
          rows={2}
          maxLength={2000}
          value={prompt}
          disabled={!ready}
          onChange={(event) => setPrompt(event.target.value)}
          className={cn(inputClassName, "min-h-16 flex-1 resize-y py-2")}
        />
        {pending ? (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            aria-label={t("aiAgents.cancelChat")}
            onClick={() => request.current?.abort()}
          >
            <Square className="size-4" aria-hidden />
          </Button>
        ) : (
          <Button
            type="button"
            disabled={!ready || !prompt.trim()}
            onClick={() => void run()}
            data-testid="behavior-preview-run"
          >
            <Play className="size-4" aria-hidden />
            {t("aiAgents.behavior.previewRun")}
          </Button>
        )}
      </div>
      {failure ? (
        <Alert tone="warning" onDismiss={() => setError(null)}>
          {failure}
        </Alert>
      ) : (
        <ResourceError error={error} onDismiss={() => setError(null)} />
      )}
      {answer || pending ? (
        <div
          role="status"
          aria-live="polite"
          className="glass-inset whitespace-pre-wrap break-words rounded-everyos-md p-3 text-sm leading-relaxed"
          data-testid="behavior-preview-answer"
        >
          {answer || t("aiAgents.thinking")}
        </div>
      ) : null}
    </section>
  );
}
