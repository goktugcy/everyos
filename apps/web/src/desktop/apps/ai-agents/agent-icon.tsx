import type { AiAgentKind } from "@everyos/shared";
import type { CSSProperties } from "react";
import { cn } from "../../../lib/cn.ts";

const marks: Record<AiAgentKind, string> = {
  hermes: "/agent-logos/hermes.svg",
  openclaw: "/agent-logos/openclaw.svg",
};

export function AiAgentIcon({
  kind,
  className,
  style,
}: {
  kind: AiAgentKind;
  className?: string;
  style?: CSSProperties;
}) {
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
