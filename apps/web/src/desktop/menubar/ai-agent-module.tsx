import { Bot, MessageCircle, Settings } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.tsx";
import { cn } from "../../lib/cn.ts";
import { useAiAgents } from "../apps/ai-agents/agent-store.ts";
import { AiAgentIcon } from "../apps/ai-agents/agent-icon.tsx";
import { SimulatedBadge } from "../apps/system/parts.tsx";
import { desktop } from "../state/controller.ts";
import { menubarButton } from "./menubar-button.ts";

export function AiAgentModule() {
  const { t } = useTranslation();
  const agents = useAiAgents((state) => state.agents),
    error = useAiAgents((state) => state.error);
  const [open, setOpen] = useState(false);
  const configured = agents.filter((agent) => agent.configured);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={cn(menubarButton, "gap-2")}
        aria-label={t("aiAgents.title")}
        data-testid="ai-agent-menubar"
      >
        {configured.length ? (
          configured.map((agent) => (
            <span
              key={agent.kind}
              className="relative"
              title={`${t(`aiAgents.names.${agent.kind}`)} · ${t(`aiAgents.statuses.${agent.status}`)}`}
            >
              <AiAgentIcon
                kind={agent.kind}
                className={cn("size-4", agent.status === "running" ? "text-fg" : "text-fg-subtle")}
              />
              <span
                className={cn(
                  "absolute -bottom-0.5 -right-1 size-1.5 rounded-full",
                  agent.busy
                    ? "bg-warning"
                    : agent.status === "running"
                      ? "bg-success"
                      : "bg-fg-subtle",
                )}
              />
            </span>
          ))
        ) : (
          <Bot className="size-4" aria-hidden />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label={t("aiAgents.title")}
          className="glass-strong z-[8000] w-[min(340px,calc(100vw-16px))] rounded-everyos-lg p-3 text-fg"
        >
          <h3 className="mb-3 text-sm font-semibold">{t("aiAgents.title")}</h3>
          {configured.map((agent) => (
            <div key={agent.kind} className="mb-2 rounded-everyos-md border border-line p-3">
              <div className="flex items-center gap-2">
                <AiAgentIcon kind={agent.kind} className="size-5" />
                <span className="text-sm font-semibold">{t(`aiAgents.names.${agent.kind}`)}</span>
                <SimulatedBadge source={agent.source} />
              </div>
              <p role="status" className="my-2 text-xs text-fg-muted">
                {t(agent.busy ? "aiAgents.busy" : `aiAgents.statuses.${agent.status}`)}
              </p>
              {agent.settings.model ? (
                <p className="mb-3 truncate text-xs text-fg-subtle">{agent.settings.model}</p>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setOpen(false);
                  desktop.openApp("everyos.agents", { appState: { kind: agent.kind } });
                }}
              >
                <MessageCircle className="size-4" aria-hidden />
                {t("aiAgents.quickChat")}
              </Button>
            </div>
          ))}
          {!configured.length ? (
            <p className="mb-3 text-xs text-fg-muted">
              {t(error ? "aiAgents.statusUnavailable" : "aiAgents.setupHint")}
            </p>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => {
              setOpen(false);
              desktop.openSettings("agents");
            }}
          >
            <Settings className="size-4" aria-hidden />
            {t("settings.sections.agents")}
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
