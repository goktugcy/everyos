import { release } from "node:os";
import type { RebootStatus } from "@everyos/shared";
import { listDirOrEmpty, pathKind, readTextOrNull } from "../fs-utils.ts";
import { hostPath, REAL_HOST, type HostPaths } from "../host-paths.ts";

const PACKAGE = /^[a-z0-9][a-z0-9+.:-]{0,127}$/;

/** Orders kernel releases like `6.8.0-49-generic` by their numeric parts. */
export function compareKernelReleases(a: string, b: string): number {
  const left = a.split(/[^0-9A-Za-z]+/);
  const right = b.split(/[^0-9A-Za-z]+/);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index] ?? "";
    const y = right[index] ?? "";
    const difference =
      /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/**
 * Whether installed updates wait for a restart: Debian/Ubuntu's `reboot-required` marker (with
 * the packages that asked for it), or a kernel in /boot newer than the running one (or the
 * running one removed). Only kernels of the running flavour (`-generic`, `-raspi`, `-rpi-v8`…)
 * count. /boot, unlike /lib/modules, stays visible to services with ProtectKernelModules.
 */
export async function collectRebootStatus(
  options: { paths?: HostPaths; kernel?: string } = {},
): Promise<RebootStatus> {
  const paths = options.paths ?? REAL_HOST;
  const status: RebootStatus = {
    source: "host",
    required: false,
    reasons: [],
    packages: [],
    kernel: null,
  };
  if (paths.platform !== "linux") return status;
  const kernel = options.kernel ?? release();
  status.kernel = /^[\w.+~-]{1,128}$/.test(kernel) ? kernel : null;
  if ((await pathKind(hostPath(paths, "/run/reboot-required"))) === "file") {
    status.reasons.push("flag");
    const listed = (await readTextOrNull(hostPath(paths, "/run/reboot-required.pkgs"), 64 * 1024))
      ?.split("\n")
      .map((line) => line.trim())
      .filter((line) => PACKAGE.test(line));
    status.packages = [...new Set(listed ?? [])].slice(0, 200);
  }
  const running = status.kernel;
  if (running && running.lastIndexOf("-") > 0) {
    const flavour = running.slice(running.lastIndexOf("-"));
    const installed = (await listDirOrEmpty(hostPath(paths, "/boot")))
      .filter((name) => name.startsWith("vmlinuz-"))
      .map((name) => name.slice("vmlinuz-".length))
      .filter((release) => release.endsWith(flavour));
    if (
      installed.length &&
      (!installed.includes(running) ||
        installed.some((release) => compareKernelReleases(release, running) > 0))
    )
      status.reasons.push("kernel");
  }
  status.required = status.reasons.length > 0;
  return status;
}
