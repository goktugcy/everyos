import type { OperationHandlers } from "@otuken/agent-protocol";
import type { SystemInfo } from "@otuken/shared";
import { collectSystemInfo } from "@otuken/system";
import type { AgentMode } from "./config.ts";

export interface HandlerDependencies {
  mode: AgentMode;
  version: string;
  startedAt: number;
  now?: () => number;
  collect?: () => Promise<SystemInfo>;
}

/** Host information changes rarely; cache it briefly to bound filesystem reads. */
const SYSTEM_INFO_TTL_MS = 10_000;

export function createHandlers(deps: HandlerDependencies): OperationHandlers {
  const now = deps.now ?? Date.now;
  const collect = deps.collect ?? (() => collectSystemInfo());
  let cached: { value: SystemInfo; at: number } | null = null;
  let inflight: Promise<SystemInfo> | null = null;

  return {
    "agent.ping": () => ({
      pong: true,
      agentVersion: deps.version,
      uptimeSeconds: Math.round((now() - deps.startedAt) / 1000),
      mode: deps.mode,
    }),

    "system.info": async () => {
      if (cached && now() - cached.at < SYSTEM_INFO_TTL_MS) return cached.value;
      // Coalesce concurrent requests into a single collection.
      inflight ??= collect().finally(() => {
        inflight = null;
      });
      const value = await inflight;
      cached = { value, at: now() };
      return value;
    },
  };
}
