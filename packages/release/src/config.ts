import {
  constants,
  readFileSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  renameSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import { ReleaseVersionSchema } from "@everyos/shared/schemas";
import { EVERYOS_VERSION } from "@everyos/shared";

export const UPDATE_ROOT = "/var/lib/everyos-updates";
export const CONFIG_PATH = "/etc/everyos/release.json";
export const ReleaseConfigSchema = z.strictObject({
  source: z
    .string()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        ((url.protocol === "https:" && (!url.port || url.port === "443")) ||
          url.protocol === "file:")
      );
    }),
  publicKey: z.string().min(1).max(4096),
  redirectHosts: z
    .array(z.string().regex(/^[a-z0-9.-]+$/))
    .max(8)
    .default([]),
  healthUrl: z
    .string()
    .default("http://127.0.0.1:7470/api/health")
    .refine((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        url.hostname === "127.0.0.1" &&
        url.pathname === "/api/health" &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password
      );
    }),
  dataDir: z
    .string()
    .regex(/^\/[^\0]+$/)
    .default("/var/lib/everyos"),
});
export type ReleaseConfig = z.infer<typeof ReleaseConfigSchema>;

/** Privileged work never consumes configuration or state writable by the API account. */
export function trustedPath(path: string, directory = false): void {
  if (realpathSync(path) !== path) throw new Error("Untrusted update path");
  const info = lstatSync(path);
  if (info.uid !== 0 || info.mode & 0o022 || (directory ? !info.isDirectory() : !info.isFile()))
    throw new Error("Update paths must be root-owned and not writable by other accounts");
  if (path !== "/") trustedPath(dirname(path), true);
}
export function releaseConfig(): ReleaseConfig | null {
  try {
    trustedPath(CONFIG_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return ReleaseConfigSchema.parse(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
}
export function installedVersion(): string {
  try {
    return ReleaseVersionSchema.parse(readFileSync("/usr/lib/everyos/VERSION", "utf8").trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EVERYOS_VERSION;
    throw error;
  }
}
export function stateDirectory(): void {
  mkdirSync(UPDATE_ROOT, { recursive: true, mode: 0o700 });
  trustedPath(UPDATE_ROOT, true);
}
export function writeState(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
export async function readBounded(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit)
      throw new Error("Release file is too large or not regular");
    const data = await handle.readFile();
    if (data.length > limit) throw new Error("Release file changed while reading");
    return data;
  } finally {
    await handle.close();
  }
}
