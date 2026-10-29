import type { ProcessDetail } from "@everyos/shared";
import { expect, it } from "vitest";
import { processExplanationData } from "./process-explanation-data.ts";

it("sends measured process metadata without command arguments, private paths or account names", () => {
  const detail: ProcessDetail = {
    source: "host",
    sampledAt: 1000,
    pid: 42,
    parentPid: 1,
    name: "worker",
    user: "private-user",
    state: "S",
    cpuPercent: 5,
    memoryBytes: 4096,
    virtualMemoryBytes: 8192,
    threads: 2,
    startedAt: 100,
    serviceUnit: "worker.service",
    containerId: null,
    command: "worker --token=secret-value",
    executable: "/private/bin/worker",
    workingDirectory: "/private/data",
  };
  const payload = processExplanationData(detail);
  expect(payload).toMatchObject({
    pid: 42,
    cpuPercent: 5,
    memoryBytes: 4096,
    source: "host",
    sampledAt: 1000,
  });
  expect(JSON.stringify(payload)).not.toMatch(
    /private|secret-value|token|command|executable|workingDirectory/,
  );
});
