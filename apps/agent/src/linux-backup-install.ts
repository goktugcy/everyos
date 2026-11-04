import { CommandError, type AptManager } from "@everyos/system";
import type { OperationEvent } from "@everyos/agent-protocol";
import type { LinuxBackups } from "./linux-backups.ts";

/** A fixed dependency installation; no command, package or repository comes from the client. */
export async function* installLinuxBackupEngine(
  apt: AptManager,
  backups: Pick<LinuxBackups, "status">,
  signal: AbortSignal,
): AsyncGenerator<OperationEvent<"backups.linux.install">> {
  try {
    const initial = await backups.status();
    if (initial.available) {
      yield { type: "done", ok: true, error: null };
      return;
    }
    if (initial.reason !== "borg-missing" || !initial.installationSupported) {
      yield { type: "done", ok: false, error: "BORG_INSTALL_FAILED" };
      return;
    }
    yield { type: "stage", stage: "refreshing" };
    const refreshed = await apt.refresh(signal);
    if (!refreshed.ok) {
      yield {
        type: "done",
        ok: false,
        error: refreshed.busy ? "BORG_INSTALL_BUSY" : "BORG_INSTALL_REFRESH_FAILED",
      };
      return;
    }
    signal.throwIfAborted();
    yield { type: "stage", stage: "installing" };
    const installed = await apt.installBorg(signal);
    if (!installed.ok) {
      yield {
        type: "done",
        ok: false,
        error: installed.busy ? "BORG_INSTALL_BUSY" : "BORG_INSTALL_FAILED",
      };
      return;
    }
    signal.throwIfAborted();
    yield { type: "stage", stage: "checking" };
    const ready = (await backups.status()).available;
    yield { type: "done", ok: ready, error: ready ? null : "BORG_INSTALL_VERIFY_FAILED" };
  } catch (error) {
    const reason = error instanceof CommandError ? error.message : "";
    const code =
      reason === "BORG_PACKAGE_UNAVAILABLE" ||
      reason === "BORG_PACKAGE_VERSION" ||
      reason === "BORG_INSTALL_EVERYOS_VERSION"
        ? reason
        : "BORG_INSTALL_FAILED";
    yield { type: "done", ok: false, error: code };
  }
}
