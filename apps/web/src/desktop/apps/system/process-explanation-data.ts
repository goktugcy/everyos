import type { ProcessDetail } from "@everyos/shared";

/** Only this allowlist leaves the inspector; never include arguments, users or filesystem paths. */
export function processExplanationData(detail: ProcessDetail) {
  return {
    source: detail.source,
    sampledAt: detail.sampledAt,
    pid: detail.pid,
    name: detail.name,
    parentPid: detail.parentPid,
    state: detail.state,
    cpuPercent: detail.cpuPercent,
    memoryBytes: detail.memoryBytes,
    virtualMemoryBytes: detail.virtualMemoryBytes,
    threads: detail.threads,
    startedAt: detail.startedAt,
    serviceUnit: detail.serviceUnit,
    containerId: detail.containerId,
  };
}
