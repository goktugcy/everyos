import { existsSync, readFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { setTimeout } from "node:timers/promises";
import type { CDPSession, Locator, Page, Request } from "@playwright/test";

/** Observations, not performance thresholds: never store capability URLs or request payloads. */
export function measureAppLaunch(page: Page) {
  const started = performance.now();
  const transfers: Promise<number>[] = [];
  let failedRequests = 0;
  const runtime = (request: Request) => new URL(request.url()).pathname.startsWith("/app-runtime/");
  const completed = (request: Request) => {
    if (runtime(request)) transfers.push(request.sizes().then((sizes) => sizes.responseBodySize));
  };
  const failed = (request: Request) => {
    if (runtime(request)) failedRequests++;
  };
  page.on("requestfinished", completed);
  page.on("requestfailed", failed);
  const stop = () => {
    page.off("requestfinished", completed);
    page.off("requestfailed", failed);
  };
  return {
    stop,
    async ready(window: Locator) {
      const launchToContentMs = performance.now() - started;
      const frame = await (
        await window.getByTestId("desktop-app-frame").elementHandle()
      )?.contentFrame();
      if (!frame) throw new Error("No installed app frame to measure");
      let session: CDPSession;
      let scope: "app-frame-renderer" | "desktop-renderer-including-app";
      try {
        session = await page.context().newCDPSession(frame);
        scope = "app-frame-renderer";
      } catch {
        // Chromium can keep a sandboxed frame in its parent's renderer. Do not call that app-only.
        session = await page.context().newCDPSession(page);
        scope = "desktop-renderer-including-app";
      }
      try {
        await session.send("Performance.enable", { timeDomain: "timeTicks" });
        const metrics = async () => {
          const result = await session.send("Performance.getMetrics");
          const task = result.metrics.find((metric) => metric.name === "TaskDuration")?.value;
          if (task === undefined) throw new Error("Chromium did not supply task duration");
          return task;
        };
        const before = await metrics();
        const sampleStart = performance.now();
        await setTimeout(3000);
        const after = await metrics();
        const idleSampleMs = performance.now() - sampleStart;
        const heap = await session.send("Runtime.getHeapUsage");
        stop();
        const bytes = await Promise.all(transfers);
        return {
          launchToContentMs: Math.round(launchToContentMs * 100) / 100,
          idleSampleMs: Math.round(idleSampleMs),
          rendererScope: scope,
          idleTaskPercentOneCore: Math.round(((after - before) / idleSampleMs) * 10_000_000) / 100,
          jsHeapUsedBytes: heap.usedSize,
          jsHeapTotalBytes: heap.totalSize,
          runtimeRequests: bytes.length,
          runtimeResponseBodyBytes: bytes.reduce((sum, size) => sum + size, 0),
          failedRuntimeRequests: failedRequests,
        };
      } finally {
        stop();
        await session.detach();
      }
    },
  };
}

export function appMeasurementEnvironment(browserVersion: string) {
  const model = existsSync("/proc/device-tree/model")
    ? readFileSync("/proc/device-tree/model", "utf8").replaceAll("\0", "").trim()
    : null;
  return {
    platform: platform(),
    architecture: arch(),
    kernel: release(),
    browserVersion,
    physicalPi: model?.startsWith("Raspberry Pi") ?? false,
    hardwareModel: model,
    cpuModel: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length,
    hostMemoryBytes: totalmem(),
    hostData: "simulated-agent",
    method:
      "single sequential first launch from the command palette; warm desktop; uncontrolled cache",
    cpu: "Chromium task time during a 3-second idle window; renderer scope is explicit per sample",
    memory:
      "JavaScript heap without forced collection; excludes native/browser and host service memory",
    network:
      "encoded runtime response bodies from launch through idle sample; excludes install and API traffic",
  };
}
