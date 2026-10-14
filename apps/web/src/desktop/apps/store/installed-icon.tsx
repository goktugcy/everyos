import { AI_AGENT_CATALOG_ID, type InstalledAppView } from "@everyos/shared";
import { Package } from "lucide-react";
import { useState } from "react";
import { AiAgentIcon } from "../ai-agents/agent-icon.tsx";

export function InstalledAppIcon({ app, size = 56 }: { app: InstalledAppView; size?: number }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  const kind =
    app.provenance.catalogId === AI_AGENT_CATALOG_ID &&
    (app.provenance.path === "hermes" || app.provenance.path === "openclaw")
      ? app.provenance.path
      : null;
  if (kind)
    return (
      <span
        className="grid shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"
        style={{ width: size, height: size }}
      >
        <AiAgentIcon kind={kind} style={{ width: size * 0.8, height: size * 0.8 }} />
      </span>
    );
  return app.icon && failedIcon !== app.icon ? (
    <img
      src={app.icon}
      alt=""
      draggable={false}
      loading="lazy"
      className="shrink-0 rounded-xl object-contain"
      style={{ width: size, height: size }}
      onError={() => setFailedIcon(app.icon!)}
    />
  ) : (
    <span
      className="grid shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"
      style={{ width: size, height: size }}
    >
      <Package style={{ width: size * 0.57, height: size * 0.57 }} aria-hidden />
    </span>
  );
}
