import { readdir, readlink } from "node:fs/promises";
import type { SocketSummary } from "@otuken/shared";
import { mapLimit, readTextOrNull } from "../fs-utils.ts";
import { hostPath, REAL_HOST, type HostPaths } from "../host-paths.ts";
import { isListening, parseProcNet, type ProcNetSocket } from "../linux/sockets.ts";
import { UnavailableError } from "../unavailable.ts";

const MAX_FDS_PER_PROCESS = 4096;

/**
 * Maps socket inodes to process names by scanning /proc/<pid>/fd. Only the
 * root agent can see other users' descriptors; unmatched sockets keep a null
 * process instead of a guess.
 */
async function ownersOf(
  paths: HostPaths,
  inodes: ReadonlySet<number>,
): Promise<Map<number, string>> {
  const owners = new Map<number, string>();
  if (inodes.size === 0) return owners;
  const proc = hostPath(paths, "/proc");
  const pids = (await readdir(proc).catch(() => [] as string[])).filter((name) =>
    /^\d+$/.test(name),
  );
  await mapLimit(pids, 16, async (pid) => {
    if (owners.size === inodes.size) return;
    const fds = await readdir(`${proc}/${pid}/fd`).catch(() => [] as string[]);
    for (const fd of fds.slice(0, MAX_FDS_PER_PROCESS)) {
      const target = await readlink(`${proc}/${pid}/fd/${fd}`).catch(() => null);
      const inode = target?.startsWith("socket:[") ? Number(target.slice(8, -1)) : null;
      if (inode !== null && inodes.has(inode) && !owners.has(inode)) {
        const comm = (await readTextOrNull(`${proc}/${pid}/comm`, 64))?.trim() ?? null;
        if (comm) owners.set(inode, comm.slice(0, 64));
      }
    }
  });
  return owners;
}

/** Listening ports and connection counts from /proc/net. */
export async function collectSockets(options: { paths?: HostPaths } = {}): Promise<SocketSummary> {
  const paths = options.paths ?? REAL_HOST;
  if (paths.platform !== "linux") throw new UnavailableError("not-linux");
  const sockets: ProcNetSocket[] = [];
  for (const [file, protocol] of [
    ["tcp", "tcp"],
    ["tcp6", "tcp"],
    ["udp", "udp"],
    ["udp6", "udp"],
  ] as const) {
    const text = await readTextOrNull(hostPath(paths, `/proc/net/${file}`), 8 * 1024 * 1024);
    if (text) sockets.push(...parseProcNet(text, protocol));
  }
  const seen = new Set<string>();
  const listening = sockets.filter(isListening).filter((socket) => {
    const key = `${socket.protocol}/${socket.address}/${socket.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const owners = await ownersOf(
    paths,
    new Set(listening.map((socket) => socket.inode).filter((inode) => inode > 0)),
  );
  const tcp = sockets.filter((socket) => socket.protocol === "tcp" && socket.state !== "0A");
  return {
    source: "host",
    listening: listening
      .slice(0, 2000)
      .map((socket) => ({
        protocol: socket.protocol,
        address: socket.address,
        port: socket.port,
        process: owners.get(socket.inode) ?? null,
      }))
      .sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol)),
    connections: {
      established: tcp.filter((socket) => socket.state === "01").length,
      timeWait: tcp.filter((socket) => socket.state === "06").length,
      other: tcp.filter((socket) => socket.state !== "01" && socket.state !== "06").length,
    },
  };
}
