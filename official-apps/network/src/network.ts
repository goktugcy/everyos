import type { NetHttpResponse, SystemMetrics, SystemNetwork } from "@everyos/app-sdk";

export interface Settings {
  url: string;
  auto: boolean;
  interfaceName: string;
}
export const DEFAULT_SETTINGS: Settings = { url: "", auto: false, interfaceName: "" };
export function readSettings(value: unknown): Settings {
  if (!value || typeof value !== "object") return DEFAULT_SETTINGS;
  const v = value as Record<string, unknown>;
  return {
    url: typeof v.url === "string" && v.url.length <= 2048 ? v.url : "",
    auto: v.auto === true,
    interfaceName:
      typeof v.interfaceName === "string" && v.interfaceName.length <= 64 ? v.interfaceName : "",
  };
}
export function probeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.href.length <= 2048
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export interface Snapshot<T> {
  value: T;
  retrievedAt: number;
}
export interface Probe {
  at: number;
  target: string;
  reply: NetHttpResponse;
}

export interface ProbeAttempt {
  at: number;
  target: string;
}

/** Diagnostics omit HTTP bodies and headers, which can contain endpoint-issued cookies. */
export function diagnosticReport(
  input: {
    network: Snapshot<SystemNetwork> | null;
    metrics: Snapshot<SystemMetrics> | null;
    networkError: string | null;
    metricsError: string | null;
    probe: Probe | null;
    attempt: ProbeAttempt | null;
    probeError: string | null;
  },
  generatedAt: number,
) {
  const reply = input.probe?.reply;
  return {
    version: 1,
    app: "dev.everyos.network",
    generatedAt,
    network: input.network,
    networkError: input.networkError,
    metrics: input.metrics
      ? {
          retrievedAt: input.metrics.retrievedAt,
          value: {
            source: input.metrics.value.source,
            measuredAt: input.metrics.value.point.at,
            interfaces: input.metrics.value.interfaces,
          },
        }
      : null,
    metricsError: input.metricsError,
    probe:
      input.probe && reply
        ? {
            at: input.probe.at,
            target: input.probe.target,
            response: {
              url: reply.url,
              status: reply.status,
              statusText: reply.statusText,
              httpVersion: reply.httpVersion,
              remoteAddress: reply.remoteAddress,
              timing: reply.timing,
              redirects: reply.redirects,
            },
          }
        : null,
    probeError: input.probeError,
    attempt: input.attempt,
  };
}
