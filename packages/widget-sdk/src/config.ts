import type { WidgetConfigValue, WidgetInstance, WidgetPreferences } from "@everyos/shared";
import { getWidget } from "./manifests.ts";
import type { WidgetConfigField, WidgetManifest } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOCKER_TARGET = /^(app|project|container):[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENTITY = /^[a-z_]+\.[a-z0-9_]{1,100}$/;
const MOUNT = /^\/[^\0]{0,255}$/;

function defaultValue(field: WidgetConfigField): WidgetConfigValue {
  switch (field.type) {
    case "boolean":
    case "select":
    case "number":
    case "mount":
      return field.default;
    case "integration":
    case "dockerTarget":
      return "";
    case "entities":
      return "all";
  }
}

export function defaultConfig(manifest: WidgetManifest): Record<string, WidgetConfigValue> {
  return Object.fromEntries(manifest.config.map((field) => [field.key, defaultValue(field)]));
}

function normalizeValue(field: WidgetConfigField, value: unknown): WidgetConfigValue {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? value : field.default;
    case "select":
      return typeof value === "string" && field.options.includes(value) ? value : field.default;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? Math.min(field.max, Math.max(field.min, Math.round(value)))
        : field.default;
    case "mount":
      return typeof value === "string" && MOUNT.test(value) ? value : field.default;
    case "integration":
      return typeof value === "string" && UUID.test(value) ? value : "";
    case "dockerTarget":
      return typeof value === "string" && DOCKER_TARGET.test(value) ? value : "";
    case "entities":
      if (value === "all") return "all";
      return Array.isArray(value)
        ? [
            ...new Set(value.filter((v): v is string => typeof v === "string" && ENTITY.test(v))),
          ].slice(0, field.maxItems)
        : [];
  }
}

/**
 * Keeps only the fields the manifest declares, with valid values (others
 * fall back to their defaults). Used on every edit and when loading layouts
 * written for an older manifest version.
 */
export function normalizeConfig(
  manifest: WidgetManifest,
  config: Readonly<Record<string, unknown>>,
): Record<string, WidgetConfigValue> {
  return Object.fromEntries(
    manifest.config.map((field) => [field.key, normalizeValue(field, config[field.key])]),
  );
}

/** Fields the user still has to fill in before the widget can show data. */
export function missingConfig(
  manifest: WidgetManifest,
  config: Readonly<Record<string, unknown>>,
): string[] {
  return manifest.config
    .filter((field) => {
      const value = config[field.key];
      if (field.type === "integration" || field.type === "dockerTarget")
        return typeof value !== "string" || value === "";
      if (field.type === "entities")
        return value !== "all" && (!Array.isArray(value) || value.length === 0);
      return false;
    })
    .map((field) => field.key);
}

/** Brings an instance written for another manifest version up to date. */
export function migrateInstance(
  instance: WidgetInstance,
  manifest: WidgetManifest,
): WidgetInstance {
  if (instance.widgetVersion === manifest.version) return instance;
  return {
    ...instance,
    widgetVersion: manifest.version,
    config: normalizeConfig(manifest, instance.config),
  };
}

/**
 * Migrates every instance of a stored layout to the current manifest
 * versions. Unknown widgets are kept (the desktop offers to remove them).
 */
export function migrateWidgets(doc: WidgetPreferences): WidgetPreferences {
  let changed = false;
  const instances = doc.instances.map((instance) => {
    const manifest = getWidget(instance.widgetId);
    const next = manifest ? migrateInstance(instance, manifest) : instance;
    if (next !== instance) changed = true;
    return next;
  });
  return changed ? { ...doc, instances } : doc;
}
