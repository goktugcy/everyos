import { chmod, lstat, mkdir, realpath, statfs, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OperationError } from "@everyos/agent-protocol";
import { CONFIG_PLACEHOLDER, inlineFiles, object, parseCompose } from "@everyos/catalogs/compose";
import { stringify } from "yaml";

/** Config contents live only on verified tmpfs; durable deployment records remain encrypted. */
export async function materializeConfigs(
  input: string,
  id: string,
  simulated: boolean,
): Promise<string> {
  const doc = parseCompose(input),
    files = inlineFiles(doc);
  const root =
    existsSync("/run/everyos/app-configs") || !existsSync("/run/otuken/app-configs")
      ? "/run/everyos/app-configs"
      : "/run/otuken/app-configs";
  if (files.length && !simulated) {
    const dir = join(root, id);
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const path of [root, dir]) {
      if (path === dir)
        await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        (await realpath(path)) !== path ||
        (await statfs(path)).type !== 0x01021994
      )
        throw new OperationError(
          "policy_denied",
          "Inline configuration requires private agent-owned tmpfs",
        );
    }
    for (const file of files) {
      const path = join(dir, file.name),
        info = await lstat(path).catch(() => null);
      if (
        info &&
        (!info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          info.uid !== process.getuid?.())
      )
        throw new OperationError("policy_denied", "Unsafe inline configuration file");
      // Private parent directories protect the host; containers must read the bound file.
      await writeFile(path, file.content.replaceAll("$$", "$"), { mode: 0o444 });
      await chmod(path, 0o444);
    }
  }
  delete doc["x-otuken-files"];
  for (const raw of Object.values(object(doc.services))) {
    const service = object(raw);
    if (Array.isArray(service.volumes))
      service.volumes = service.volumes.map((raw: unknown) => {
        const entry = object(raw);
        if (typeof entry.source === "string" && entry.source.startsWith(`${CONFIG_PLACEHOLDER}/`))
          return {
            ...entry,
            source: entry.source.replace(CONFIG_PLACEHOLDER, `${root}/${id}`),
          };
        return raw;
      });
  }
  return stringify(doc, { lineWidth: 0 });
}
