import type {
  CapabilityId,
  DataTopic,
  EventTopic,
  IntegrationAdapter,
  Permission,
  WidgetPlacement,
  WidgetSize,
} from "@everyos/shared";

/** Declarative configuration fields; the configuration UI and validation are generated from them. */
export type WidgetConfigField =
  | { key: string; type: "boolean"; default: boolean }
  | { key: string; type: "select"; options: string[]; default: string }
  | { key: string; type: "number"; min: number; max: number; default: number }
  /** An integration of the given adapter, chosen from those the user can see. */
  | { key: string; type: "integration"; adapter: IntegrationAdapter }
  /** A container, Compose project or installed app ("app:<id>", "project:<name>", "container:<name>"). */
  | { key: string; type: "dockerTarget" }
  | { key: string; type: "mount"; default: string }
  /** Home Assistant entities exposed by the chosen integration. */
  | { key: string; type: "entities"; control: boolean; maxItems: number };

export type WidgetCategory =
  "system" | "storage" | "network" | "docker" | "raspberryPi" | "apps" | "ai";

/** `{integration}` is replaced by the configured integration id. */
export type WidgetTopicTemplate =
  EventTopic | DataTopic | `data.integration.{integration}.${string}`;

/** A versioned widget manifest (docs/contracts.md §3.1). */
export interface WidgetManifest {
  schemaVersion: 1;
  id: string;
  /** Bumped when the configuration format changes; older configurations are migrated. */
  version: number;
  provider: "system" | "docker" | "raspberryPi" | "ai" | IntegrationAdapter;
  categories: WidgetCategory[];
  supportedSizes: WidgetSize[];
  defaultSize: WidgetSize;
  placements: WidgetPlacement[];
  /** Every permission is required to add the widget and to receive its data. */
  permissions: Permission[];
  requiresCapability?: CapabilityId;
  /** Empty for interactive widgets that call their own API routes (e.g. AI chat). */
  dataSources: Array<{ topic: WidgetTopicTemplate; minIntervalMs: number }>;
  config: WidgetConfigField[];
}
