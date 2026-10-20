/**
 * What a desktop app may ask for (docs/app-sdk/permissions.md). A capability in a manifest is only
 * a request: the server decides on every call, from the installation's grants and the role of the
 * person using the app.
 */
export const APP_CAPABILITIES = [
  "storage:app",
  "files:pick",
  "files:save",
  "notifications:send",
  "clipboard:write",
  "widgets:register",
  "appearance:manage",
  "system:metrics.read",
  "system:sockets.read",
  "system:network.read",
  "logs:read",
  "storage:usage.read",
  "network:outbound",
  "database:connect",
  "secrets:ssh",
] as const;

/** A hybrid app's backend, reached only through a configured integration of this adapter. */
export type IntegrationCapability = `integration:${string}`;

export type AppCapability = (typeof APP_CAPABILITIES)[number] | IntegrationCapability;

export const INTEGRATION_CAPABILITY_PATTERN = /^integration:[a-z][a-z0-9-]{1,31}$/;

export function isAppCapability(value: unknown): value is AppCapability {
  return (
    typeof value === "string" &&
    ((APP_CAPABILITIES as readonly string[]).includes(value) ||
      INTEGRATION_CAPABILITY_PATTERN.test(value))
  );
}

/**
 * - `standard`: comes with the install (the user mediates it, or it touches only the app's data).
 * - `sensitive`: shown at install and approved by whoever installs the app.
 * - `elevated`: an administrator grants it explicitly; an install or update never implies it.
 */
export type CapabilityRisk = "standard" | "sensitive" | "elevated";

export interface CapabilityInfo {
  risk: CapabilityRisk;
  /** EveryOS role permissions the person using the app needs as well. */
  requires: readonly string[];
}

export const CAPABILITY_INFO: Readonly<Record<(typeof APP_CAPABILITIES)[number], CapabilityInfo>> =
  {
    "storage:app": { risk: "standard", requires: [] },
    "files:pick": { risk: "standard", requires: ["files:read"] },
    "files:save": { risk: "standard", requires: ["files:write"] },
    "notifications:send": { risk: "standard", requires: [] },
    "clipboard:write": { risk: "standard", requires: [] },
    "widgets:register": { risk: "standard", requires: [] },
    "appearance:manage": { risk: "sensitive", requires: ["preferences:manage"] },
    "system:metrics.read": { risk: "sensitive", requires: ["system:read"] },
    "system:sockets.read": { risk: "sensitive", requires: ["system:read"] },
    "system:network.read": { risk: "sensitive", requires: ["system:read"] },
    "logs:read": { risk: "sensitive", requires: ["logs:read"] },
    "storage:usage.read": { risk: "sensitive", requires: ["files:read"] },
    "network:outbound": { risk: "elevated", requires: [] },
    "database:connect": { risk: "elevated", requires: [] },
    "secrets:ssh": { risk: "sensitive", requires: [] },
  };

export function capabilityInfo(capability: AppCapability): CapabilityInfo {
  return INTEGRATION_CAPABILITY_PATTERN.test(capability)
    ? { risk: "sensitive", requires: ["apps:read"] }
    : CAPABILITY_INFO[capability as (typeof APP_CAPABILITIES)[number]];
}
