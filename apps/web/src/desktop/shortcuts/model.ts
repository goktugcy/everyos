import { isShortcutUrl, type CustomShortcut, type DockerContainerView } from "@everyos/shared";
import type { DesktopAppManifest } from "../apps/types.ts";

export interface ShortcutCandidate {
  id: string;
  name: string;
  detail: string;
  source: CustomShortcut["source"];
  permission: "apps:read" | "docker:read" | null;
  target: CustomShortcut["target"];
  url: string;
  icon: string | null;
  manifest?: DesktopAppManifest;
  simulated: boolean;
}

/** Suggestions use real published TCP bindings; no network probing or service changes. */
export function containerShortcutUrls(
  container: Pick<DockerContainerView, "ports" | "webUiTemplate">,
  hostname: string,
  simulated: boolean,
): string[] {
  if (simulated) return [];
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
  const ports = container.ports.filter(
    (p) =>
      p.type === "tcp" && p.publicPort && (local || !["127.0.0.1", "::1"].includes(p.ip ?? "")),
  );
  const template = container.webUiTemplate;
  let suggested: string | null = null;
  if (template) {
    let missing = false;
    const value = template
      .replaceAll("[IP]", hostname)
      .replace(/\[PORT:(\d{1,5})\]/g, (_match, port: string) => {
        const bound = ports.find((p) => p.privatePort === Number(port));
        if (!bound) missing = true;
        return String(bound?.publicPort ?? "");
      });
    if (!missing && isShortcutUrl(value)) suggested = value;
  }
  return [
    ...new Set([
      ...(suggested ? [suggested] : []),
      ...ports.map(
        (p) => `${p.privatePort === 443 ? "https" : "http"}://${hostname}:${p.publicPort}/`,
      ),
    ]),
  ];
}
