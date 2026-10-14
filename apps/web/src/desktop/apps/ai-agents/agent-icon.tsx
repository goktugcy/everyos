import type { AiAgentKind } from "@everyos/shared";
import { Bot, Shell } from "lucide-react";

export function AiAgentIcon({ kind, className }: { kind: AiAgentKind; className?: string }) {
  const Icon = kind === "hermes" ? Bot : Shell;
  return <Icon className={className} aria-hidden />;
}
