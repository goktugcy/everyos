import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { LinuxAccount } from "@everyos/shared";

/** PID 1 starts the account outside the root agent's read-only /home mount namespace. */
export function spawnAccount(
  account: LinuxAccount,
  file: string,
  args: readonly string[],
  runtime = "1h",
): ChildProcessWithoutNullStreams {
  const unit = `everyos-account-${randomUUID()}.service`;
  const child = spawn(
    "/usr/bin/systemd-run",
    [
      "--quiet",
      "--wait",
      "--collect",
      "--pipe",
      "--service-type=exec",
      `--unit=${unit}`,
      `--uid=${account.name}`,
      `--gid=${account.gid}`,
      "--property=KillMode=control-group",
      `--property=RuntimeMaxSec=${runtime}`,
      "--property=UMask=0077",
      `--working-directory=${account.home}`,
      "--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      `--setenv=HOME=${account.home}`,
      `--setenv=USER=${account.name}`,
      `--setenv=LOGNAME=${account.name}`,
      "--",
      file,
      ...args,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } },
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Only the UUID-named unit created here is stopped; never a host service.
    const cleanup = spawn("/usr/bin/systemctl", ["stop", unit], {
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin" },
    });
    cleanup.once("error", () => undefined);
  };
  child.stdin.on("close", stop);
  child.once("close", stop);
  child.once("error", stop);
  return child;
}
