import type { OperationPolicy } from "@otuken/agent-protocol";
import { isAllowedOnProtected } from "./protection.ts";
import type { AgentMode } from "./config.ts";

/** Stable prefixes of denial reasons so clients can explain them in their own language. */
export const POLICY_REASONS = {
  protectedUnit: "PROTECTED_UNIT",
  protectedContainer: "PROTECTED_CONTAINER",
  developmentMode: "DEVELOPMENT_MODE",
} as const;

/** Docker operations that change the host's Docker state. */
const DOCKER_MUTATIONS = new Set([
  "apps.run",
  "docker.containers.control",
  "docker.images.remove",
  "docker.volumes.remove",
  "docker.networks.remove",
  "docker.compose.run",
]);

export interface PolicyOptions {
  mode: AgentMode;
  isProtected: (unit: string) => boolean;
  /** Where service operations are answered from; the simulator never touches the host. */
  servicesSource: "host" | "simulated";
  /** Same for Docker operations. */
  dockerSource: "host" | "simulated";
  /** Same for package updates. */
  aptSource?: "host" | "simulated";
}

/**
 * Operation-specific rules applied after the permission check. They hold
 * regardless of the caller's role: not even an admin can stop the agent or
 * SSH through Otuken, and a development agent never changes the host.
 */
export function createPolicy(options: PolicyOptions): OperationPolicy {
  return (op, params) => {
    if (DOCKER_MUTATIONS.has(op)) {
      return options.mode === "development" && options.dockerSource === "host"
        ? {
            allowed: false,
            reason: `${POLICY_REASONS.developmentMode}: changing Docker on the host is disabled in development mode`,
          }
        : { allowed: true };
    }
    if (op === "apt.refresh" || op === "apt.upgrade") {
      return options.mode === "development" && options.aptSource !== "simulated"
        ? {
            allowed: false,
            reason: `${POLICY_REASONS.developmentMode}: changing host packages is disabled in development mode`,
          }
        : { allowed: true };
    }
    if (op !== "services.control") return { allowed: true };
    const { unit, action } = params as {
      unit: string;
      action: Parameters<typeof isAllowedOnProtected>[0];
    };
    if (options.mode === "development" && options.servicesSource === "host") {
      return {
        allowed: false,
        reason: `${POLICY_REASONS.developmentMode}: changing host services is disabled in development mode`,
      };
    }
    if (options.isProtected(unit) && !isAllowedOnProtected(action)) {
      return {
        allowed: false,
        reason: `${POLICY_REASONS.protectedUnit}: ${unit} is protected; "${action}" is not allowed from Otuken`,
      };
    }
    return { allowed: true };
  };
}
