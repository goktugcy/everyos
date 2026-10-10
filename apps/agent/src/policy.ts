import type { OperationPolicy } from "@otuken/agent-protocol";

/**
 * Operation-specific rules applied after the permission check.
 *
 * Phase 1 exposes only read-only operations, so every registered operation is
 * allowed for actors holding its permission. Later phases add rules here, for
 * example refusing to stop `otuken-agent.service`, `ssh.service` or other
 * protected systemd units regardless of the caller's role.
 */
export function createPolicy(): OperationPolicy {
  return () => ({ allowed: true });
}
