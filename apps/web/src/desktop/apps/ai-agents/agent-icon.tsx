import type { AiAgentKind } from "@everyos/shared";
import { BrainCircuit } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "../../../lib/cn.ts";

const marks: Record<Exclude<AiAgentKind, "local">, string> = {
  hermes: "/agent-logos/hermes.svg",
  openclaw: "/agent-logos/openclaw.svg",
};

/** Agent marks, plus a generic model symbol for local models (and the EveryOS Ollama). */
export function AiAgentIcon({
  kind,
  className,
  style,
}: {
  kind: AiAgentKind;
  className?: string;
  style?: CSSProperties;
}) {
  if (kind === "local")
    return (
      <BrainCircuit
        aria-hidden
        data-agent-logo={kind}
        className={cn("inline-block size-[1em] shrink-0 align-middle", className)}
        style={style}
      />
    );
  const mask = `url("${marks[kind]}")`;
  return (
    <span
      aria-hidden
      data-agent-logo={kind}
      className={cn("inline-block size-[1em] shrink-0 align-middle", className)}
      style={{
        backgroundColor: "currentColor",
        maskImage: mask,
        WebkitMaskImage: mask,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
        ...style,
      }}
    />
  );
}
