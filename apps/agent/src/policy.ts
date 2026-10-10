import type { OperationPolicy } from "@otuken/agent-protocol";
import { isAllowedOnProtected } from "./protection.ts";
import type { AgentMode } from "./config.ts";

/** Stable prefixes of denial reasons so clients can explain them in their own language. */
export const POLICY_REASONS = {
  protectedUnit: "PROTECTED_UNIT",
  developmentMode: "DEVELOPMENT_MODE",
} as const;

export interface PolicyOptions {
  mode: AgentMode;
  isProtected: (unit: string) => boolean;
  /** Where service operations are answered from; the simulator never touches the host. */
  servicesSource: "host" | "simulated";
}

/**
 * Operation-specific rules applied after the permission check. They hold
 * regardless of the caller's role: not even an admin can stop the agent or
 * SSH through Otuken, and a development agent never changes the host.
 */
export function createPolicy(options: PolicyOptions): OperationPolicy {
  return (op, params) => {
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
