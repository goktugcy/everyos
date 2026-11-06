import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsModule from "node:fs";

const state = vi.hoisted(() => ({
  safe: false,
  allowCommands: false,
  audit: "",
  files: new Map<string, string>(),
  record: {
    job: {
      id: "753f71fb-5029-4e32-ac36-c27340cdb18b",
      version: "0.1.49",
      previousVersion: "0.1.48",
      backupId: "fixture",
      state: "queued",
      createdAt: 1,
      finishedAt: null as number | null,
      error: null as string | null,
    },
    actor: { userId: "fixture", username: "fixture" },
  },
}));
vi.mock("@everyos/system/package-safety", () => ({
  PackageEnvironmentError: class extends Error {},
  assertPackageMutationSafe: vi.fn(() =>
    state.safe ? Promise.resolve() : Promise.reject(new Error("masked modules")),
  ),
}));
vi.mock("@everyos/logger", () => ({ createLogger: () => ({ info: vi.fn() }) }));
vi.mock("./config.ts", () => ({
  UPDATE_ROOT: "/fixture/updates",
  stateDirectory: vi.fn(),
  trustedPath: vi.fn(),
  releaseConfig: vi.fn(() => ({ dataDir: "/fixture/data" })),
  writeState: vi.fn((path: string, value: unknown) => state.files.set(path, JSON.stringify(value))),
}));
vi.mock("./manager.ts", () => ({ readJob: () => state.record }));
vi.mock("./transport.ts", () => ({
  readReleaseFile: vi.fn(() => Promise.reject(new Error("Unexpected download"))),
}));
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) =>
      state.allowCommands
        ? callback(null, { stdout: file === "/usr/bin/dpkg" ? state.audit : "", stderr: "" })
        : callback(new Error("Fixture refuses command execution")),
  ),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof FsModule>()),
  existsSync: vi.fn((path: string) => state.files.has(path)),
  readFileSync: vi.fn((path: string) => {
    const value = state.files.get(path);
    if (value === undefined) throw new Error("Missing fixture file");
    return value;
  }),
  rmSync: vi.fn((path: string) => {
    state.files.delete(path);
  }),
  openSync: vi.fn(() => 1),
  closeSync: vi.fn(),
  fsyncSync: vi.fn(),
  writeSync: vi.fn(),
}));
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { assertPackageMutationSafe } from "@everyos/system/package-safety";
import { readReleaseFile } from "./transport.ts";
import { runWorker } from "./worker.ts";

describe.skipIf(process.platform !== "linux")("update worker unsafe-environment recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "getuid").mockReturnValue(0);
    state.safe = false;
    state.allowCommands = false;
    state.audit = "";
    state.files.clear();
    state.record.job.state = "queued";
    state.record.job.finishedAt = null;
    state.record.job.error = null;
  });
  afterEach(() => vi.restoreAllMocks());
  const transaction = () => {
    state.files.set(
      "/fixture/updates/transaction.json",
      JSON.stringify({
        jobId: state.record.job.id,
        installing: true,
        snapshot: true,
        uid: 1,
        gid: 1,
      }),
    );
    state.files.set("/run/everyos-update-maintenance", state.record.job.id);
  };
  it("refuses before downloads, downtime or dpkg when the service view is unsafe", async () => {
    await runWorker();
    expect(state.record.job).toMatchObject({
      state: "failed",
      error: "package-environment-unsafe",
    });
    expect(execFile).not.toHaveBeenCalled();
    expect(readReleaseFile).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });
  it("retains a failed transaction and maintenance marker instead of discarding the recovery state", async () => {
    transaction();
    state.record.job.state = "failed";
    state.record.job.finishedAt = 10;
    await runWorker();
    expect(state.files.has("/fixture/updates/transaction.json")).toBe(true);
    expect(state.files.has("/run/everyos-update-maintenance")).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });
  it("resumes retained recovery only after the environment is safe, clearing the old terminal timestamp", async () => {
    transaction();
    state.record.job.state = "failed";
    state.record.job.finishedAt = 10;
    state.safe = true;
    await expect(runWorker()).rejects.toThrow("Fixture refuses command execution");
    expect(state.record.job).toMatchObject({ state: "rolling-back", finishedAt: null });
    expect(assertPackageMutationSafe).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/systemctl",
      ["stop", "everyos-api.service", "everyos-agent.service"],
      expect.any(Object),
      expect.any(Function),
    );
    expect(state.files.has("/fixture/updates/transaction.json")).toBe(true);
  });
  it("retains recovery state when dpkg audit still reports unfinished configuration", async () => {
    transaction();
    state.files.set(
      "/fixture/updates/transaction.json",
      JSON.stringify({
        jobId: state.record.job.id,
        installing: false,
        snapshot: false,
        uid: 1,
        gid: 1,
      }),
    );
    state.safe = true;
    state.allowCommands = true;
    state.audit = "linux-image fixture is half-configured";
    await runWorker();
    expect(state.record.job).toMatchObject({ state: "failed", error: "package-state-unsafe" });
    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/dpkg",
      ["--audit"],
      expect.any(Object),
      expect.any(Function),
    );
    expect(rmSync).not.toHaveBeenCalled();
    expect(state.files.has("/fixture/updates/transaction.json")).toBe(true);
    expect(state.files.has("/run/everyos-update-maintenance")).toBe(true);
  });
});
