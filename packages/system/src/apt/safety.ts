import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import { release } from "node:os";
import { hostPath, REAL_HOST, type HostPaths } from "../host-paths.ts";

export class PackageEnvironmentError extends Error {
  constructor() {
    super("PACKAGE_ENVIRONMENT_UNSAFE");
    this.name = "PackageEnvironmentError";
  }
}

interface Mount {
  point: string;
  readOnly: boolean;
}

function mountTable(text: string): Mount[] {
  if (!text.trim() || text.length > 4 * 1024 * 1024) throw new PackageEnvironmentError();
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const fields = line.split(" ");
      const separator = fields.indexOf("-");
      if (separator < 6 || !fields[4]?.startsWith("/") || !fields[separator + 3])
        throw new PackageEnvironmentError();
      const point = fields[4].replace(/\\(040|011|012|134)/g, (_, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
      );
      return {
        point,
        readOnly:
          fields[5]!.split(",").includes("ro") || fields[separator + 3]!.split(",").includes("ro"),
      };
    });
}

/** Check the caller's actual mount view, not a unit file that may have changed since it started. */
export async function assertPackageMutationSafe(
  options: { paths?: HostPaths; kernel?: string } = {},
): Promise<void> {
  const paths = options.paths ?? REAL_HOST;
  const kernel = options.kernel ?? release();
  if (paths.platform !== "linux" || !/^[A-Za-z0-9._+~-]{1,128}$/.test(kernel))
    throw new PackageEnvironmentError();
  try {
    const mounts = mountTable(await readFile(hostPath(paths, "/proc/self/mountinfo"), "utf8"));
    const sameHostObject = async (path: string, directory: boolean) => {
      const local = hostPath(paths, path);
      const [visible, host] = await Promise.all([
        stat(local, { bigint: true }),
        stat(hostPath(paths, `/proc/1/root${path}`), { bigint: true }),
      ]);
      if (
        visible.dev !== host.dev ||
        visible.ino !== host.ino ||
        (directory ? !visible.isDirectory() : !visible.isFile())
      )
        throw new PackageEnvironmentError();
      await access(local, constants.R_OK | (directory ? constants.X_OK : 0));
    };
    const writableHostTree = async (path: string) => {
      await sameHostObject(path, true);
      const absolute = await realpath(hostPath(paths, path));
      const canonical = paths.root === "/" ? absolute : absolute.slice(paths.root.length);
      if (!canonical.startsWith("/")) throw new PackageEnvironmentError();
      const containing = mounts
        .filter(
          (m) => m.point === "/" || canonical === m.point || canonical.startsWith(m.point + "/"),
        )
        .sort((a, b) => b.point.length - a.point.length)[0];
      if (!containing || containing.readOnly) throw new PackageEnvironmentError();
      const children = mounts.filter((m) => m.point.startsWith(canonical + "/"));
      if (children.length > 256) throw new PackageEnvironmentError();
      for (const child of children) {
        if (child.readOnly) throw new PackageEnvironmentError();
        await sameHostObject(child.point, true);
      }
    };
    // Both spellings matter on distributions without a merged /usr. At least one must exist.
    let moduleTrees = 0;
    for (const path of ["/lib/modules", "/usr/lib/modules"]) {
      const [local, host] = await Promise.allSettled([
        stat(hostPath(paths, path)),
        stat(hostPath(paths, `/proc/1/root${path}`)),
      ]);
      if (
        local.status === "rejected" &&
        host.status === "rejected" &&
        (local.reason as NodeJS.ErrnoException).code === "ENOENT" &&
        (host.reason as NodeJS.ErrnoException).code === "ENOENT"
      )
        continue;
      if (local.status !== "fulfilled" || host.status !== "fulfilled")
        throw new PackageEnvironmentError();
      await writableHostTree(path);
      await sameHostObject(`${path}/${kernel}`, true);
      await sameHostObject(`${path}/${kernel}/modules.dep`, false);
      moduleTrees++;
    }
    if (!moduleTrees) throw new PackageEnvironmentError();
    await writableHostTree("/boot");
    await writableHostTree("/var/lib/dpkg");
  } catch {
    // Never let an unreadable/unknown environment fall through to a package maintainer script.
    throw new PackageEnvironmentError();
  }
}
