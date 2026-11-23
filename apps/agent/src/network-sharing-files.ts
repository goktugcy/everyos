import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { addressAllowed } from "@everyos/catalogs";
export { tcpReachable as reachable } from "@everyos/security";
import { OperationError } from "@everyos/agent-protocol";
import { escapeUnitPath } from "@everyos/system";
import type { z } from "zod";
import type { AgentMountInputSchema } from "@everyos/shared/schemas";

export type MountInput = z.infer<typeof AgentMountInputSchema>;
export const SAMBA_INCLUDE =
  "# BEGIN EveryOS network sharing\ninclude = /etc/samba/everyos-network.conf\n# END EveryOS network sharing\n";
export const OWNED_HEADER = "# Managed by EveryOS network sharing; do not edit.\n";
export const fail = (reason: string): never => {
  throw new OperationError("conflict", reason);
};
export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.geteuid?.() ||
    (s.mode & 0o077) !== 0
  )
    fail("SHARING_CONFIG_UNSAFE");
}
export async function privateRead(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const s = await handle.stat();
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.uid !== process.geteuid?.() ||
      (s.mode & 0o077) !== 0 ||
      s.size > 256 * 1024
    )
      fail("SHARING_CONFIG_UNSAFE");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
/** Atomic replacement only after comparing the exact prior bytes; never adopt an administrator file. */
export async function replaceFile(
  path: string,
  value: string | null,
  previous: string | null,
  mode = 0o600,
) {
  let current: string | null = null;
  try {
    const s = await lstat(path);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.geteuid?.())
      fail("SHARING_CONFIG_CONFLICT");
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current !== previous) fail("SHARING_CONFIG_CONFLICT");
  if (value === null) {
    if (current !== null) await unlink(path);
    return;
  }
  const tmp = path + "." + randomUUID() + ".tmp";
  const h = await open(tmp, "wx", mode);
  try {
    await h.writeFile(value);
    await h.chmod(mode);
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function mountAddress(host: string): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  let addresses: Array<{ address: string }>;
  try {
    addresses = isIP(host)
      ? [{ address: host }]
      : await Promise.race([
          lookup(host, { all: true }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new OperationError("timeout", "SHARING_UNREACHABLE")),
              3000,
            );
          }),
        ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const local = new BlockList();
  local.addSubnet("127.0.0.0", 8, "ipv4");
  local.addAddress("::1", "ipv6");
  if (
    !addresses.length ||
    addresses.length > 16 ||
    addresses.some(
      (a) =>
        !addressAllowed(a.address, true) ||
        local.check(a.address, isIP(a.address) === 4 ? "ipv4" : "ipv6"),
    )
  )
    fail("SHARING_NETWORK_DENIED");
  return addresses[0]!.address;
}
/** Only a trailing managed include is amended; the administrator's inode, owner and ACLs stay intact. */
export async function amendConfig(path: string, next: string, previous: string) {
  if (next === previous) return;
  const longer = next.length > previous.length ? next : previous;
  const shorter = next.length > previous.length ? previous : next;
  const tail = longer.slice(shorter.length);
  if (!longer.startsWith(shorter) || !["\n" + SAMBA_INCLUDE, "\n\n" + SAMBA_INCLUDE].includes(tail))
    fail("SHARING_CONFIG_CONFLICT");
  const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.geteuid?.() ||
      info.size > 1024 * 1024 ||
      (await handle.readFile("utf8")) !== previous
    )
      fail("SHARING_CONFIG_CONFLICT");
    const current = await lstat(path);
    if (current.dev !== info.dev || current.ino !== info.ino) fail("SHARING_CONFIG_CONFLICT");
    if (next.length > previous.length) {
      const tail = Buffer.from(next.slice(previous.length));
      await handle.write(tail, 0, tail.length, Buffer.byteLength(previous));
    } else await handle.truncate(Buffer.byteLength(next));
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export const unitQuote = (s: string) =>
  '"' +
  s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("\n", "\\n") +
  '"';
// Mount fields take literal values, unlike ExecStart arguments: enclosing quotes become path bytes.
const mountValue = (s: string) => {
  if (
    s.includes("\\") ||
    s.trim() !== s ||
    Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    fail("SHARING_PROTOCOL_SETTINGS");
  return s.replaceAll("%", "%%");
};
export function mountUnits(
  input: MountInput,
  target: string,
  credentialPath: string,
  uid: number,
  gid: number,
) {
  const smb = input.protocol === "smb";
  if (
    (smb &&
      (!["3.1.1", "3.0", "2.1"].includes(input.version) ||
        !/^[A-Za-z0-9_.$ -]{1,80}$/.test(input.remotePath))) ||
    (!smb &&
      (!["4.2", "4.1", "4", "3"].includes(input.version) || !input.remotePath.startsWith("/")))
  )
    fail("SHARING_PROTOCOL_SETTINGS");
  const host = input.host.includes(":") ? "[" + input.host + "]" : input.host;
  const source = smb ? "//" + host + "/" + input.remotePath : host + ":" + input.remotePath;
  const options = ["nosuid", "nodev", "noexec", "_netdev", input.readOnly ? "ro" : "rw"];
  if (smb)
    options.push(
      "vers=" + input.version,
      "credentials=" + credentialPath,
      "uid=" + uid,
      "gid=" + gid,
      "file_mode=0600",
      "dir_mode=0700",
      "port=" + input.port,
      "echo_interval=5",
      "nodfs",
      "forceuid",
      "forcegid",
      ...(input.version.startsWith("3") ? ["seal"] : []),
    );
  else
    options.push(
      "vers=" + input.version,
      "proto=tcp",
      "port=" + input.port,
      "hard",
      "timeo=50",
      "retrans=2",
      "retry=0",
    );
  const common = [
    OWNED_HEADER.trimEnd(),
    "[Unit]",
    "Description=EveryOS network folder",
    "Wants=network-online.target",
    "After=network-online.target",
  ];
  const mount = [
    ...common,
    "",
    "[Mount]",
    "What=" + mountValue(source),
    "Where=" + mountValue(target),
    "Type=" + (smb ? "cifs" : "nfs"),
    "Options=" + mountValue(options.join(",")),
    "TimeoutSec=12",
    "DirectoryMode=0700",
    "",
  ].join("\n");
  const automount = [
    OWNED_HEADER.trimEnd(),
    "[Unit]",
    "Description=EveryOS on-demand network folder",
    "",
    "[Automount]",
    "Where=" + mountValue(target),
    "DirectoryMode=0700",
    "TimeoutIdleSec=120",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
  return { name: escapeUnitPath(target), mount, automount, source };
}
export function mountedTarget(text: string, target: string, includeAutomount = false) {
  return text.split("\n").some((line) => {
    const p = line.split(" "),
      path = p[4]?.replace(/\\([0-7]{3})/g, (_, oct: string) =>
        String.fromCharCode(parseInt(oct, 8)),
      );
    return path === target && (includeAutomount || !line.includes(" - autofs "));
  });
}
export function parseNetworkMounts(text: string) {
  const decode = (value: string) =>
    value.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
  return text
    .split("\n")
    .flatMap((line) => {
      const [left, right] = line.split(" - ");
      const a = left?.split(" "),
        b = right?.split(" ");
      if (!a || !b || !["nfs", "nfs4", "cifs"].includes(b[0] ?? "") || !a[4] || !b[1]) return [];
      return [
        {
          protocol: b[0] === "cifs" ? ("smb" as const) : ("nfs" as const),
          source: decode(b[1]),
          target: decode(a[4]),
          readOnly: (a[5] ?? "").split(",").includes("ro"),
        },
      ];
    })
    .slice(0, 256);
}
