import type { AiAgentView, AiModelCatalog, AiModelRef } from "@everyos/shared";
import { Check, ChevronDown, Cpu, Loader2, RefreshCw, Search } from "lucide-react";
import { Popover } from "radix-ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { ResourceError } from "../system/parts.tsx";
import { useAiAgents } from "./agent-store.ts";

/** Long provider lists stay responsive: only this many matches are drawn at once. */
const SHOWN = 150;
const same = (a: AiModelRef | null, b: AiModelRef | null) =>
  a !== null && b !== null && a.model === b.model && a.provider === b.provider;

/** The model a chat uses, and a menu that lists the agent's models and switches between them. */
export function ModelPicker({
  agent,
  disabled = false,
  className,
}: {
  agent: AiAgentView;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const refreshAgents = useAiAgents((state) => state.refresh);
  // An agent EveryOS has no model setting for (e.g. a Hermes found on the host) names its own
  // default only in its model list; asking once lets the chip and later answers show it.
  const unknown = agent.configured && agent.status === "running" && !agent.chatModel;
  const asked = useRef(false);
  useEffect(() => {
    if (!unknown || asked.current) return;
    asked.current = true;
    const controller = new AbortController();
    void api<AiModelCatalog>(`/ai-agents/${agent.kind}/models`, { signal: controller.signal })
      .then((catalog) => {
        if (catalog.current && !controller.signal.aborted) void refreshAgents();
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [unknown, agent.kind, refreshAgents]);
  const label = agent.chatModel?.model ?? t("aiAgents.models.unknown");
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        disabled={disabled || !agent.configured}
        aria-label={t("aiAgents.models.current", { model: label })}
        title={t("aiAgents.models.current", { model: label })}
        data-testid="ai-chat-model"
        className={cn(
          "flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-hover/8 px-2.5 text-xs text-fg-muted outline-none hover:bg-hover/14 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-60 disabled:hover:bg-hover/8",
          className,
        )}
      >
        <Cpu className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label={t("aiAgents.models.label")}
          className="glass-strong z-[8000] flex max-h-[min(480px,70vh)] w-[min(360px,calc(100vw-16px))] flex-col rounded-everyos-lg p-2 text-fg"
        >
          {open ? <ModelMenu agent={agent} onDone={() => setOpen(false)} /> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ModelMenu({ agent, onDone }: { agent: AiAgentView; onDone: () => void }) {
  const { t } = useTranslation();
  const refreshAgents = useAiAgents((state) => state.refresh);
  const [catalog, setCatalog] = useState<AiModelCatalog | null>(null);
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const name = t(`aiAgents.names.${agent.kind}`);
  const fetchCatalog = useCallback(
    (fresh: boolean, signal?: AbortSignal) =>
      api<AiModelCatalog>(
        `/ai-agents/${agent.kind}/models${fresh ? "?refresh=1" : ""}`,
        signal ? { signal } : {},
      )
        .then((result) => {
          if (!signal?.aborted) setCatalog(result);
        })
        .catch((error: unknown) => {
          if (!signal?.aborted) setError(error);
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        }),
    [agent.kind],
  );
  useEffect(() => {
    const controller = new AbortController();
    void fetchCatalog(false, controller.signal);
    return () => controller.abort();
  }, [fetchCatalog]);
  const reload = () => {
    setLoading(true);
    setError(null);
    void fetchCatalog(true);
  };
  const choose = async (model: AiModelRef | null) => {
    if (!catalog || saving) return;
    const restart = catalog.switching === "restart";
    if (
      restart &&
      !(await requestConfirm({
        title: t("aiAgents.models.restartTitle", { model: model?.model ?? "" }),
        body: t("aiAgents.models.restartConfirm"),
        confirmLabel: t("aiAgents.models.restart"),
        danger: false,
      }))
    )
      return;
    setSaving(true);
    setError(null);
    try {
      await api(`/ai-agents/${agent.kind}/model`, {
        method: "PUT",
        body: { model, ...(restart ? { restart: true } : {}) },
      });
      await refreshAgents();
      onDone();
    } catch (error) {
      setError(error);
    } finally {
      setSaving(false);
    }
  };
  const needle = query.trim().toLocaleLowerCase();
  const matching = (catalog?.groups ?? []).map((group) => ({
    ...group,
    models: needle
      ? group.models.filter((model) => model.toLocaleLowerCase().includes(needle))
      : group.models,
  }));
  // Only the first SHOWN matches across all groups are drawn.
  const groups = matching.map((group, index) => {
    const before = matching
      .slice(0, index)
      .reduce((sum, previous) => sum + previous.models.length, 0);
    return { ...group, models: group.models.slice(0, Math.max(0, SHOWN - before)) };
  });
  const total = (catalog?.groups ?? []).reduce((sum, group) => sum + group.models.length, 0);
  const busy = loading || saving;
  const itemClass =
    "flex w-full items-center gap-2 rounded-everyos-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-hover/10 focus-visible:bg-[rgb(var(--everyos-accent)/0.2)] disabled:opacity-50";
  const current = catalog?.current ?? agent.chatModel;
  return (
    <div className="flex min-h-0 flex-col gap-2" aria-busy={busy}>
      <div className="flex items-center gap-2 px-1">
        <h3 className="flex-1 text-sm font-semibold">{t("aiAgents.models.label")}</h3>
        {busy ? <Loader2 className="size-4 animate-spin text-fg-subtle" aria-hidden /> : null}
        <button
          type="button"
          className="grid size-7 place-items-center rounded-md text-fg-muted outline-none hover:bg-hover/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          aria-label={t("aiAgents.models.refresh")}
          title={t("aiAgents.models.refresh")}
          disabled={busy}
          onClick={reload}
        >
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
      </div>
      {total > 8 ? (
        <label
          htmlFor={searchId}
          className="glass-inset mx-1 flex h-8 items-center gap-2 rounded-everyos-md px-2.5"
        >
          <Search className="size-3.5 text-fg-subtle" aria-hidden />
          <input
            id={searchId}
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("aiAgents.models.search")}
            aria-label={t("aiAgents.models.search")}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-fg-subtle"
          />
        </label>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-1" role="listbox" aria-label={name}>
        {loading && !catalog ? (
          <p className="px-2 py-3 text-xs text-fg-muted">{t("aiAgents.models.loading")}</p>
        ) : null}
        {catalog?.agentDefault ? (
          <button
            type="button"
            role="option"
            aria-selected={!catalog.chosen}
            disabled={busy}
            className={itemClass}
            onClick={() => (catalog.chosen ? void choose(null) : onDone())}
          >
            <Check className={cn("size-3.5 shrink-0", catalog.chosen && "invisible")} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">
                {t("aiAgents.models.defaultOf", { agent: name })}
              </span>
              <span className="block truncate text-fg-subtle">{catalog.agentDefault.model}</span>
            </span>
          </button>
        ) : null}
        {groups.map((group) => {
          if (!group.models.length) return null;
          return (
            <div key={group.provider ?? "models"} role="group" aria-label={group.name || name}>
              {group.provider !== null ? (
                <p className="px-2 pb-1 pt-2.5 text-[0.7rem] font-semibold uppercase tracking-wide text-fg-subtle">
                  {group.name}
                </p>
              ) : null}
              {group.models.map((model) => {
                const ref = { provider: group.provider, model };
                // While Hermes uses its own default, only the default entry is marked.
                const selected =
                  (catalog?.agentDefault === null || catalog?.chosen === true) &&
                  same(current, ref);
                return (
                  <button
                    type="button"
                    role="option"
                    key={model}
                    aria-selected={selected}
                    disabled={busy}
                    className={itemClass}
                    onClick={() => (selected ? onDone() : void choose(ref))}
                  >
                    <Check
                      className={cn("size-3.5 shrink-0", !selected && "invisible")}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{model}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {catalog && total > 0 && matching.every((group) => !group.models.length) ? (
          <p className="px-2 py-3 text-xs text-fg-muted">{t("aiAgents.models.empty")}</p>
        ) : null}
      </div>
      {catalog?.problem ? (
        <p className="px-2 text-xs leading-relaxed text-fg-muted" role="status">
          {t(`aiAgents.models.problems.${catalog.problem}`, { agent: name })}
        </p>
      ) : null}
      <ResourceError error={error} onDismiss={() => setError(null)} />
      {catalog && !catalog.problem ? (
        <p className="border-t border-line px-2 pt-2 text-[0.7rem] leading-relaxed text-fg-subtle">
          {catalog.chosen ? `${t("aiAgents.models.chosen", { agent: name })} ` : ""}
          {t(
            catalog.switching === "restart"
              ? "aiAgents.models.restartHint"
              : "aiAgents.models.instant",
          )}
          {catalog.truncated || total > SHOWN ? ` ${t("aiAgents.models.truncated")}` : ""}
        </p>
      ) : null}
    </div>
  );
}
