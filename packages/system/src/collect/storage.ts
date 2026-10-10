import { statfs } from "node:fs/promises";
import type { StorageUsage } from "@otuken/shared";
import { readTextOrNull } from "../fs-utils.ts";
import { hostPath, REAL_HOST, type HostPaths } from "../host-paths.ts";
import { parseMounts, type MountEntry } from "../linux/procfs.ts";

const STATFS_TIMEOUT_MS = 2_000;
/** Mounts that did not answer statfs in time (e.g. an offline NAS) are skipped for a while. */
const unresponsive = new Map<string, number>();
const UNRESPONSIVE_BACKOFF_MS = 5 * 60_000;

async function usage(
  mount: MountEntry,
  now: number,
): Promise<StorageUsage["mounts"][number] | null> {
  const skippedAt = unresponsive.get(mount.mountpoint);
  if (skippedAt && now - skippedAt < UNRESPONSIVE_BACKOFF_MS) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stats = await Promise.race([
      statfs(mount.mountpoint),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("statfs timeout")), STATFS_TIMEOUT_MS);
      }),
    ]);
    unresponsive.delete(mount.mountpoint);
    const total = stats.blocks * stats.bsize;
    return {
      ...mount,
      totalBytes: total,
      usedBytes: Math.max(0, (stats.blocks - stats.bfree) * stats.bsize),
      availableBytes: stats.bavail * stats.bsize,
      inodesTotal: stats.files,
      inodesFree: stats.ffree,
    };
  } catch (error) {
    if ((error as Error).message === "statfs timeout") unresponsive.set(mount.mountpoint, now);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Mounted data filesystems with their capacity. Pseudo filesystems are excluded. */
export async function collectStorage(
  options: { paths?: HostPaths; now?: () => number } = {},
): Promise<StorageUsage> {
  const paths = options.paths ?? REAL_HOST;
  const now = (options.now ?? Date.now)();
  const mounts: MountEntry[] =
    paths.platform === "linux"
      ? parseMounts((await readTextOrNull(hostPath(paths, "/proc/mounts"), 512 * 1024)) ?? "").map(
          (m) => ({
            ...m,
            mountpoint: paths.root === "/" ? m.mountpoint : hostPath(paths, m.mountpoint),
          }),
        )
      : [{ device: "root", mountpoint: "/", fsType: "apfs", readOnly: false }];
  const results: StorageUsage["mounts"] = [];
  // Sequential on purpose: a hung network mount must not occupy several libuv threads.
  for (const mount of mounts.slice(0, 256)) {
    const entry = await usage(mount, now);
    if (entry && entry.totalBytes > 0) {
      results.push(
        paths.root === "/"
          ? entry
          : { ...entry, mountpoint: entry.mountpoint.slice(paths.root.length) || "/" },
      );
    }
  }
  return { source: "host", mounts: results };
}
