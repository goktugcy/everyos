import type { OperationEvent } from "@everyos/agent-protocol";
import { createPolicy } from "./policy.ts";
import { describe, expect, it, vi } from "vitest";
import { createAptSimulator } from "@everyos/system";
import type { LinuxBackupCapability } from "@everyos/shared";
import { installLinuxBackupEngine } from "./linux-backup-install.ts";
const missing: LinuxBackupCapability = {
  source: "simulated",
  available: false,
  reason: "borg-missing",
  version: null,
  installationSupported: true,
  targets: [],
  systemIncludes: [],
  alwaysExcluded: [],
};

async function collect(stream: AsyncIterable<OperationEvent<"backups.linux.install">>) {
  const events: OperationEvent<"backups.linux.install">[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("BorgBackup installation lifecycle", () => {
  it("never permits host package changes from a development fixture", () => {
    const policy = createPolicy({
      mode: "development",
      servicesSource: "simulated",
      dockerSource: "simulated",
      isProtected: () => false,
      aptSource: "host",
      linuxBackupsSource: "simulated",
    });
    expect(
      policy(
        "backups.linux.install",
        {},
        { kind: "user", userId: "fixture", username: "fixture", role: "admin" },
      ),
    ).toMatchObject({ allowed: false });
  });
  it("checks the actual executable before reporting success", async () => {
    const apt = createAptSimulator();
    const status = vi
      .fn()
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce({
        ...missing,
        available: true,
        reason: "ready",
        version: "borg 1.4.5",
      });
    const events = await collect(
      installLinuxBackupEngine(apt, { status }, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: "stage", stage: "refreshing" },
      { type: "stage", stage: "installing" },
      { type: "stage", stage: "checking" },
      { type: "done", ok: true, error: null },
    ]);
    expect(status).toHaveBeenCalledTimes(2);
  });
  it("does not mistake a successful package command for a usable Borg executable", async () => {
    const events = await collect(
      installLinuxBackupEngine(
        createAptSimulator(),
        { status: () => Promise.resolve(missing) },
        new AbortController().signal,
      ),
    );
    expect(events.at(-1)).toEqual({ type: "done", ok: false, error: "BORG_INSTALL_VERIFY_FAILED" });
  });
  it("reports a busy package manager without attempting installation", async () => {
    const apt = createAptSimulator();
    apt.refresh = () => Promise.resolve({ ok: false, busy: true, output: "fixture lock" });
    const install = vi.spyOn(apt, "installBorg");
    const events = await collect(
      installLinuxBackupEngine(
        apt,
        { status: () => Promise.resolve(missing) },
        new AbortController().signal,
      ),
    );
    expect(events.at(-1)).toMatchObject({ ok: false, error: "BORG_INSTALL_BUSY" });
    expect(install).not.toHaveBeenCalled();
  });
});
