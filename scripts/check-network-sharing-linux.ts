/** Destructive native qualification, restricted to fresh GitHub-hosted Linux VMs. Never run on a user's host. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chown, chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { SecretBox } from "../packages/security/src/index.ts";
import { silentLogger } from "../packages/logger/src/index.ts";
import { createAptManager } from "../packages/system/src/index.ts";
import { AGENT_OPERATIONS, type OperationContext } from "../packages/agent-protocol/src/index.ts";
import { AgentMountInputSchema } from "../packages/shared/src/schemas/index.ts";
import { networkRootId, type NetworkConnection } from "../packages/shared/src/index.ts";
import { NetworkSharing, networkExecute } from "../apps/agent/src/network-sharing.ts";
import { SftpFiles, SftpPool } from "../apps/api/src/modules/sharing/sftp.ts";

assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 0);
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.env.EVERYOS_DISPOSABLE_NETWORK_TEST, "1");
assert.equal((await readFile("/proc/1/comm", "utf8")).trim(), "systemd");
for (const path of [
  "/etc/everyos",
  "/var/lib/everyos-agent",
  "/etc/samba/everyos-network.conf",
  "/srv/everyos-network-shares",
  "/mnt/everyos-network",
]) {
  const existing = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  assert.equal(existing, null, "Refusing a VM with existing EveryOS sharing state: " + path);
}
const suffix = randomUUID().slice(0, 8),
  username = "evnet_" + suffix;
const source = "/srv/everyos-network-fixture-" + suffix,
  home = source + "/home",
  data = source + "/data";
const state = "/var/lib/everyos-network-fixture-" + suffix;
// Keep fixture mounts on /srv; /mnt may depend on a runner's unavailable ephemeral-disk unit.
const mountRoot = source + "/mounts",
  runtime = "/run/everyos-network-fixture-" + suffix;
const host = Object.values(networkInterfaces())
  .flatMap((v) => v ?? [])
  .find((v) => v.family === "IPv4" && !v.internal)?.address;
assert.ok(host, "A non-loopback VM address is required");
await mkdir(data, { recursive: true });
await mkdir(home, { recursive: true });
await networkExecute("useradd", ["--home-dir", home, "--shell", "/bin/sh", username]);
const uid = Number((await networkExecute("id", ["-u", username])).trim()),
  gid = Number((await networkExecute("id", ["-g", username])).trim());
assert.ok(uid >= 1000 && gid > 0);
const password = randomBytes(24).toString("base64url");
await networkExecute("chpasswd", [], username + ":" + password + "\n");
for (const path of [home, data]) {
  await chown(path, uid, gid);
  await chmod(path, 0o700);
}
const actor = {
  kind: "user" as const,
  userId: randomUUID(),
  username: "fixture",
  role: "admin" as const,
};
const context: OperationContext = {
  actor,
  signal: new AbortController().signal,
  logger: silentLogger,
};
const asUser = (args: readonly string[]) =>
  networkExecute("setpriv", ["--reuid=" + uid, "--regid=" + gid, "--init-groups", ...args]);
const options = {
  execute: async (...args: Parameters<typeof networkExecute>) => {
    try {
      return await networkExecute(...args);
    } catch (error) {
      if (args[0] === "systemctl") {
        const unit = args[1].find((v) => /\.(?:mount|automount|service)$/.test(v));
        if (unit) {
          console.error(
            "Failed fixture unit:",
            unit,
            await networkExecute("systemctl", [
              "show",
              unit,
              "--property=LoadState,LoadError,ActiveState,SubState,Result,Requires,After",
            ]).catch(() => "Unit state unavailable"),
            await networkExecute("journalctl", ["-u", unit, "-n", "20", "--no-pager"]).catch(
              () => "Unit journal unavailable",
            ),
            await networkExecute("systemctl", [
              "show",
              unit.replace(/\.automount$/, ".mount"),
              "--property=LoadState,LoadError,ActiveState,SubState,Result,What,Where,Requires",
            ]).catch(() => "Related mount state unavailable"),
          );
        }
      }
      throw error;
    }
  },
  root: state,
  mountRoot,
  runtime,
  secrets: new SecretBox(randomBytes(32)),
  apt: createAptManager(),
  account: () => ({ name: username, uid, gid, home, shell: "/bin/sh" }),
  inspect: async (input: { root: string; path: string; readOnly: boolean }) => {
    // Match the production worker's strict IPC contract, including rejection of extra fields.
    input = AGENT_OPERATIONS["files.share.inspect"].params.parse(input);
    assert.equal(input.root, "fixture");
    assert.equal(input.path, "data");
    await asUser(["/usr/bin/test", "-r", data]);
    await asUser(["/usr/bin/test", "-x", data]);
    if (!input.readOnly) await asUser(["/usr/bin/test", "-w", data]);
    const s = await lstat(data);
    return { path: data, device: s.dev, inode: s.ino };
  },
};
let network = new NetworkSharing(options);
const connections: string[] = [],
  shares: string[] = [];
const pool = new SftpPool();
try {
  await network.initialize();
  await network.exports.smbAccount(username, password, context);
  for (const protocol of ["nfs", "smb"] as const) {
    const id = randomUUID();
    shares.push(id);
    const name = "EveryOS_CI_" + suffix + "_" + protocol;
    await network.exports.apply(
      {
        id,
        name,
        protocol,
        root: "fixture",
        path: "data",
        readOnly: false,
        enabled: true,
        clients: [host + "/32"],
        users: [username],
        confirm: true,
      },
      context,
    );
    const connectionId = randomUUID();
    connections.push(connectionId);
    const input = AgentMountInputSchema.parse({
      id: connectionId,
      name,
      protocol,
      host,
      port: protocol === "nfs" ? 2049 : 445,
      remotePath: protocol === "nfs" ? "/srv/everyos-network-shares/" + id : name,
      username,
      ...(protocol === "smb" ? { password } : {}),
      readOnly: false,
      enabled: true,
      persistent: true,
      automount: true,
      version: protocol === "nfs" ? "4.2" : "3.1.1",
    });
    const { target } = await network.apply(input, context);
    await network.control(connectionId, "connect", actor);
    assert.ok((await network.status(actor)).mounts.some((m) => m.id === connectionId && m.mounted));
    await asUser(["/usr/bin/touch", target + "/" + protocol + "-written"]);
    await readFile(data + "/" + protocol + "-written");
    if (protocol === "nfs")
      assert.match(await networkExecute("exportfs", ["-s"]), new RegExp("anonuid=" + uid));
    await network.control(connectionId, "disconnect", actor);
    // Reloading the manager models agent restart and restores runtime credentials from sealed state.
    network = new NetworkSharing(options);
    await network.initialize();
    await network.control(connectionId, "connect", actor);
    await asUser(["/usr/bin/test", "-f", target + "/" + protocol + "-written"]);
  }
  await assert.rejects(
    networkExecute("setpriv", [
      "--reuid=65534",
      "--regid=65534",
      "--clear-groups",
      "/usr/bin/touch",
      data + "/denied",
    ]),
  );
  // An unreachable endpoint enables only an automount. It never waits for a remote mount at boot.
  const offlineId = randomUUID();
  connections.push(offlineId);
  const began = Date.now();
  await network.apply(
    AgentMountInputSchema.parse({
      id: offlineId,
      name: "Offline",
      protocol: "nfs",
      host: "192.0.2.1",
      port: 2049,
      remotePath: "/offline",
      username: "",
      readOnly: true,
      enabled: true,
      persistent: true,
      automount: true,
      version: "4.2",
    }),
    context,
  );
  assert.ok(
    Date.now() - began < 10000,
    "Enabling an offline automount must not wait for its server",
  );
  await assert.rejects(network.control(offlineId, "connect", actor));
  // Actual OpenSSH, independently checked against the VM's public host-key fingerprints.
  await network.service("sftp", "start");
  await mkdir(home + "/.ssh", { mode: 0o700 });
  await chown(home + "/.ssh", uid, gid);
  const key = source + "/client-key";
  await networkExecute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  await writeFile(home + "/.ssh/authorized_keys", await readFile(key + ".pub"), { mode: 0o600 });
  await chown(home + "/.ssh/authorized_keys", uid, gid);
  const fingerprint = await pool.probe(host, 22),
    known = [];
  for (const name of (await readdir("/etc/ssh")).filter((n) => /^ssh_host_.*_key.pub$/.test(n)))
    known.push(
      (
        await networkExecute("ssh-keygen", ["-l", "-E", "sha256", "-f", join("/etc/ssh", name)])
      ).split(/\s+/)[1],
    );
  assert.ok(known.includes(fingerprint));
  const id = randomUUID();
  const connection: NetworkConnection = {
    id,
    name: "OpenSSH",
    protocol: "sftp",
    host,
    port: 22,
    remotePath: data,
    username,
    readOnly: false,
    enabled: true,
    persistent: false,
    automount: true,
    version: "sftp",
    fingerprint,
    root: networkRootId(id),
    mountPoint: null,
    state: "disconnected",
    reason: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const files = new SftpFiles({
    connection,
    pool,
    owner: actor.userId,
    credentials: { privateKey: await readFile(key, "utf8") },
    maxUploadBytes: 16 * 1024 ** 2,
  });
  const bytes = Buffer.alloc(4 * 1024 ** 2, 0x65);
  await files.upload(
    connection.root,
    "",
    "large.bin",
    Readable.toWeb(Readable.from([bytes])) as WebReadableStream<Uint8Array>,
    bytes.length,
    false,
  );
  assert.deepEqual(await readFile(data + "/large.bin"), bytes);
  await files.writeText(connection.root, "edit.txt", "first", null);
  const text = await files.readText(connection.root, "edit.txt");
  await files.writeText(connection.root, "edit.txt", "second", text.etag);
  assert.equal((await files.readText(connection.root, "edit.txt")).content, "second");
  console.log(
    "Native NFS/SMB units, encrypted CIFS, UID isolation, manager restart, offline automount and OpenSSH SFTP passed on",
    process.arch,
  );
} finally {
  pool.close();
  for (const id of connections.reverse())
    await network
      .remove(id, actor)
      .catch((error) => console.error("Connection cleanup failed", id, error));
  for (const id of shares.reverse())
    await network.exports
      .remove(id, context)
      .catch((error) => console.error("Share cleanup failed", id, error));
  await networkExecute("smbpasswd", ["-x", username]).catch(() => undefined);
  await networkExecute("userdel", [username]).catch(() => undefined);
  const mountInfo = await readFile("/proc/1/mountinfo", "utf8");
  assert.ok(
    !mountInfo
      .split("\n")
      .some(
        (line) =>
          line.split(" ")[4]?.startsWith(mountRoot + "/") ||
          line.split(" ")[4]?.startsWith("/srv/everyos-network-shares/"),
      ),
    "Refusing to remove data while a fixture mount remains",
  );
  for (const path of [source, state, runtime, mountRoot])
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
}
