import { chmod, chown, copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { OperationError } from "@otuken/agent-protocol";

/** Copy only regular owned-instance data, while its source containers are stopped. */
export async function copyManagedData(
  source: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  let bytes = 0,
    entries = 0;
  const copy = async (from: string, to: string): Promise<void> => {
    signal.throwIfAborted();
    const info = await lstat(from);
    if (++entries > 10_000 || (bytes += info.isFile() ? info.size : 0) > 1024 ** 3)
      throw new OperationError("invalid_params", "Application data exceeds copy limits");
    if (
      info.isSymbolicLink() ||
      (!info.isDirectory() && !info.isFile()) ||
      (info.isFile() && info.nlink !== 1)
    )
      throw new OperationError("policy_denied", "Application data contains a link or special file");
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(from)) await copy(join(from, entry), join(to, entry));
    } else await copyFile(from, to);
    await chmod(to, info.mode & 0o777);
    if (process.getuid?.() === 0) await chown(to, info.uid, info.gid);
  };
  await copy(source, target);
}
