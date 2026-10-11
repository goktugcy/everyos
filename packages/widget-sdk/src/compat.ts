import {
  WIDGET_SIZE_CELLS,
  type CapabilityId,
  type CapabilityStatus,
  type Permission,
  type WidgetConfigValue,
  type WidgetInstance,
  type WidgetPlacement,
  type WidgetSize,
} from "@everyos/shared";
import type { WidgetManifest } from "./types.ts";

export interface WidgetContext {
  permissions: readonly Permission[];
  /** Host capabilities; null while unknown (widgets are not hidden then). */
  capabilities: Partial<Record<CapabilityId, CapabilityStatus>> | null;
}

export type WidgetAvailability =
  | { ok: true }
  | { ok: false; reason: "permission" }
  | { ok: false; reason: "capability"; capability: CapabilityId; status: CapabilityStatus };

/** Whether this user on this host can use the widget at all. */
export function widgetAvailability(
  manifest: WidgetManifest,
  context: WidgetContext,
): WidgetAvailability {
  if (!manifest.permissions.every((permission) => context.permissions.includes(permission)))
    return { ok: false, reason: "permission" };
  const capability = manifest.requiresCapability;
  const status = capability ? context.capabilities?.[capability] : undefined;
  if (capability && status && !status.available)
    return { ok: false, reason: "capability", capability, status };
  return { ok: true };
}

/** Sizes a widget offers in a placement: the menu bar shows compact widgets only. */
export function sizesFor(manifest: WidgetManifest, placement: WidgetPlacement): WidgetSize[] {
  if (placement === "menubar") return manifest.supportedSizes.filter((size) => size === "compact");
  const panel = manifest.supportedSizes.filter((size) => size !== "compact");
  return placement === "desktop" ? [...panel, "custom"] : panel.filter((size) => size !== "custom");
}

export function supportsPlacement(manifest: WidgetManifest, placement: WidgetPlacement): boolean {
  return manifest.placements.includes(placement) && sizesFor(manifest, placement).length > 0;
}

/** Desktop footprint in grid cells. */
export function cellsOf(instance: Pick<WidgetInstance, "size" | "custom">): {
  w: number;
  h: number;
} {
  if (instance.size === "custom" && instance.custom) return instance.custom;
  if (instance.size === "compact" || instance.size === "custom") return WIDGET_SIZE_CELLS.small;
  return WIDGET_SIZE_CELLS[instance.size];
}

/** Concrete topics for an instance (`{integration}` filled in); unconfigured integration topics are skipped. */
export function resolveTopics(
  manifest: WidgetManifest,
  config: Readonly<Record<string, WidgetConfigValue>>,
): string[] {
  const integration = typeof config.integration === "string" ? config.integration : "";
  return manifest.dataSources.flatMap(({ topic }) => {
    if (!topic.includes("{integration}")) return [topic];
    return integration ? [topic.replace("{integration}", integration)] : [];
  });
}
