export interface BackupMount {
  path: string;
  device: string;
  filesystem: string;
  subvolume: string | null;
}
const under = (path: string, root: string) =>
  path === root || path.startsWith(root === "/" ? "/" : root + "/");
export function backupMounts(text: string): BackupMount[] {
  const result: BackupMount[] = [];
  for (const row of text.split("\n")) {
    const [left, right] = row.split(" - ");
    const fields = left?.split(" ");
    const path = fields?.[4]?.replace(/\\([0-7]{3})/g, (_, code: string) =>
      String.fromCharCode(parseInt(code, 8)),
    );
    const device = fields?.[2];
    const filesystem = right?.split(" ")[0];
    if (path?.startsWith("/") && device && filesystem)
      result.push({
        path,
        device,
        filesystem,
        subvolume: /(?:^|,)subvolid=(\d+)(?:,|$)/.exec(right?.split(" ")[2] ?? "")?.[1] ?? null,
      });
  }
  return result.sort((a, b) => a.path.length - b.path.length);
}

/** Bind mounts can share st_dev with a parent: --one-file-system alone does not stop loops. */
export function backupMountSelection(
  mounts: BackupMount[],
  roots: string[],
  full: boolean,
  blocked: string[],
) {
  const paths = [...roots];
  const identity = (mount: BackupMount) =>
    mount.device +
    (mount.filesystem === "btrfs" && mount.subvolume ? ":subvol:" + mount.subvolume : "");
  const devices = new Set(
    roots.map((root) => {
      const mount = mounts
        .filter((m) => under(root, m.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
      return mount ? identity(mount) : "";
    }),
  );
  const excluded: string[] = [];
  for (const mount of mounts) {
    if (mount.path === "/") continue;
    if (blocked.some((p) => under(mount.path, p))) {
      excluded.push(mount.path);
      continue;
    }
    if (roots.some((p) => under(p, mount.path))) {
      devices.add(identity(mount));
      continue;
    }
    const automaticOmit = [
      "/mnt",
      "/media",
      "/var/lib/docker",
      "/var/lib/containers",
      "/snap",
    ].some((p) => under(mount.path, p));
    const inScope = full || roots.some((p) => under(mount.path, p));
    if (
      inScope &&
      !automaticOmit &&
      /^(ext[234]|xfs|btrfs|vfat|f2fs|zfs|bcachefs)$/.test(mount.filesystem) &&
      !devices.has(identity(mount))
    ) {
      paths.push(mount.path);
      devices.add(identity(mount));
    } else excluded.push(mount.path);
  }
  return { paths, excluded };
}
