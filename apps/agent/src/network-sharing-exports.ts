import { readFile, readdir, mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import { OperationError, type OperationContext } from "@everyos/agent-protocol";
import { AgentExportInputSchema } from "@everyos/shared/schemas";
import {
  fail,
  OWNED_HEADER,
  SAMBA_INCLUDE,
  privateDirectory,
  privateRead,
  replaceFile,
  unitQuote,
  amendConfig,
  mountedTarget,
} from "./network-sharing-files.ts";
import type { NetworkSharing } from "./network-sharing.ts";

const StoredExport = z.strictObject({
  owner: z.string(),
  input: AgentExportInputSchema,
  path: z.string(),
  device: z.number(),
  inode: z.number(),
  target: z.string(),
  unit: z.string(),
  config: z.string(),
  users: z.array(z.string()),
  uid: z.number().int().min(1),
  gid: z.number().int().nonnegative(),
});
type Stored = z.infer<typeof StoredExport>;
// A bind export shares its backing filesystem: guard against guessed handles outside the approved subtree.
export const nfsOptions = (readOnly: boolean, uid: number, gid: number, id: string) =>
  [
    readOnly ? "ro" : "rw",
    "sync",
    "root_squash",
    "all_squash",
    "anonuid=" + uid,
    "anongid=" + gid,
    "subtree_check",
    "fsid=" + id,
    "sec=sys",
  ].join(",");
/** Runs only as a fixed PID 1 oneshot, outside the agent's read-only home mount namespace. */
export const NETWORK_BIND_HELPER = [
  "import json, os, re, stat, subprocess, sys",
  "fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)",
  "s = os.fstat(fd)",
  "assert stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1 and s.st_mode & 0o077 == 0 and s.st_size <= 8192",
  "with os.fdopen(fd) as f: cfg = json.load(f)",
  "assert re.fullmatch(r'/srv/everyos-network-shares/[a-f0-9-]{36}', cfg['target'])",
  "current = os.open('/', os.O_PATH | os.O_DIRECTORY)",
  "try:",
  "    for part in cfg['path'].split('/'):",
  "        if not part: continue",
  "        assert part not in ('.', '..')",
  "        nxt = os.open(part, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)",
  "        os.close(current)",
  "        current = nxt",
  "    s = os.fstat(current)",
  "    assert s.st_dev == cfg['device'] and s.st_ino == cfg['inode']",
  "    p = os.lstat(cfg['target'])",
  "    assert stat.S_ISDIR(p.st_mode) and not stat.S_ISLNK(p.st_mode)",
  "    subprocess.run(['/bin/mount', '--bind', '/proc/self/fd/' + str(current), cfg['target']], pass_fds=(current,), timeout=10, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
  "    subprocess.run(['/bin/mount', '-o', 'remount,bind,nosuid,nodev,noexec' + (',ro' if cfg['readOnly'] else ',rw'), cfg['target']], timeout=10, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
  "finally:",
  "    os.close(current)",
  "",
].join("\n");

export function nfsClients(clients: readonly string[]) {
  if (!clients.length || clients.length > 32) fail("SHARING_CLIENTS_REQUIRED");
  for (const client of clients) {
    const [host, prefix] = client.split("/");
    const family = isIP(host ?? "");
    if (
      !family ||
      host === "0.0.0.0" ||
      host === "::" ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))
    )
      fail("SHARING_CLIENT_INVALID");
  }
  return [...new Set(clients)];
}
/** exportfs CLI brackets the IPv6 address, with a CIDR prefix outside the bracket. */
export function nfsTarget(client: string, path: string) {
  const [host, prefix] = client.split("/");
  return (
    (host!.includes(":") ? "[" + host + "]" + (prefix === undefined ? "" : "/" + prefix) : client) +
    ":" +
    path
  );
}
export class NetworkExports {
  readonly network: NetworkSharing;
  #simulated = new Map<string, Stored>();
  constructor(network: NetworkSharing) {
    this.network = network;
  }
  get directory() {
    return join(this.network.root, "exports");
  }
  async initialize() {
    const n = this.network;
    await privateDirectory(this.directory);
    const helper = join(n.root, "bind-helper.py");
    await replaceFile(helper, NETWORK_BIND_HELPER, await privateRead(helper), 0o600);
  }
  async records(): Promise<Stored[]> {
    if (this.network.source === "simulated") return [...this.#simulated.values()];
    const names = await readdir(this.directory).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    });
    const result: Stored[] = [];
    for (const name of names.filter((v) => /^[a-f0-9-]{36}\.json$/.test(v)).slice(0, 256)) {
      const text = await privateRead(join(this.directory, name));
      if (text) result.push(StoredExport.parse(JSON.parse(text)));
    }
    return result;
  }
  async account(username: string) {
    const line = await this.network.execute("getent", ["passwd", username]);
    const parts = line.trim().split(":");
    if (
      parts[0] !== username ||
      !/^\d+$/.test(parts[2] ?? "") ||
      Number(parts[2]) < 1000 ||
      Number(parts[2]) === 65534
    )
      fail("SHARING_LINUX_ACCOUNT");
  }
  async smbAccount(username: string, password: string, context: OperationContext) {
    this.network.owner(context.actor);
    if (this.network.source === "simulated") return null;
    await this.account(username);
    const backend = (
      await this.network.execute("testparm", [
        "--suppress-prompt",
        "--parameter-name=passdb backend",
      ])
    ).trim();
    if (!/^(?:tdbsam|smbpasswd)(?::\/[^\r\n]*)?$/.test(backend)) fail("SHARING_CONFIG_CONFLICT");
    await this.network.execute(
      "smbpasswd",
      ["-s", "-a", username],
      password + "\n" + password + "\n",
      context.signal,
    );
    return null;
  }
  async #samba(records: Stored[], activate = true) {
    const n = this.network;
    const path = "/etc/samba/everyos-network.conf";
    const previous = await readFile(path, "utf8").catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    });
    if (previous !== null && !previous.startsWith(OWNED_HEADER)) fail("SHARING_CONFIG_CONFLICT");
    const text =
      OWNED_HEADER +
      records
        .filter((r) => r.input.protocol === "smb" && r.input.enabled)
        .map((r) => r.config)
        .join("\n");
    const basePath = "/etc/samba/smb.conf";
    const base = await readFile(basePath, "utf8");
    const marker = SAMBA_INCLUDE;
    if (base.includes("# BEGIN EveryOS network sharing") && !base.includes(marker))
      fail("SHARING_CONFIG_CONFLICT");
    // Refuse collisions with administrator sections; names are matched case-insensitively by Samba.
    const sections = [...base.matchAll(/^\s*\[([^\]]+)\]/gm)].map((m) => m[1]!.toLowerCase());
    if (
      records.some(
        (r) => r.input.protocol === "smb" && sections.includes(r.input.name.toLowerCase()),
      )
    )
      fail("SHARING_NAME_CONFLICT");
    const next = base.includes(marker)
      ? base
      : base + (base.endsWith("\n") ? "" : "\n") + "\n" + marker;
    await replaceFile(path, text, previous, 0o644);
    try {
      if (next !== base) await amendConfig(basePath, next, base);
      await n.execute("testparm", ["--suppress-prompt", basePath]);
      if (activate) await n.service("smb", "start");
      const active = await n.execute("systemctl", ["is-active", "smbd.service"]).then(
        (v) => v.trim() === "active",
        () => false,
      );
      if (active) await n.service("smb", "reload");
    } catch (error) {
      if (next !== base) await amendConfig(basePath, base, next).catch(() => undefined);
      await replaceFile(path, previous, text, 0o644).catch(() => undefined);
      // A reload may have reached the daemon before reporting failure. Reapply the restored bytes.
      const active = await n.execute("systemctl", ["is-active", "smbd.service"]).then(
        (v) => v.trim() === "active",
        () => false,
      );
      if (active) await n.service("smb", "reload").catch(() => undefined);
      throw error;
    }
  }
  async #nfs(record: Stored, enable: boolean) {
    const n = this.network;
    const options = nfsOptions(record.input.readOnly, record.uid, record.gid, record.input.id);
    for (const client of nfsClients(record.input.clients)) {
      const target = nfsTarget(client, record.target);
      await n.execute("exportfs", enable ? ["-i", "-o", options, target] : ["-u", target]);
    }
  }
  async apply(input: z.infer<typeof AgentExportInputSchema>, context: OperationContext) {
    const n = this.network,
      owner = n.owner(context.actor);
    input = AgentExportInputSchema.parse(input);
    const existing = (await this.records()).find((r) => r.input.id === input.id);
    if (existing && existing.owner !== owner)
      throw new OperationError("forbidden", "Share owner mismatch");
    if (existing && existing.input.protocol !== input.protocol) fail("SHARING_PROTOCOL_SETTINGS");
    const records = await this.records();
    if (
      records.some(
        (r) =>
          r.input.id !== input.id &&
          r.input.protocol === input.protocol &&
          r.input.name.toLowerCase() === input.name.toLowerCase(),
      )
    )
      fail("SHARING_NAME_CONFLICT");
    if (records.length >= 256 && !existing) throw new OperationError("busy", "SHARING_LIMIT");
    if (input.protocol === "nfs") nfsClients(input.clients);
    if (existing && !input.enabled) {
      const disabled = await this.#disable(existing, records);
      if (n.source === "simulated") this.#simulated.set(input.id, { ...disabled, input });
      else
        await replaceFile(
          join(this.directory, input.id + ".json"),
          JSON.stringify({ ...disabled, input }),
          JSON.stringify(disabled),
        );
      return null;
    }
    const folder =
      n.source === "simulated"
        ? { path: "/simulated/" + input.root + "/" + input.path, device: 1, inode: 1 }
        : await n.options.inspect(
            { root: input.root, path: input.path, readOnly: input.readOnly },
            context,
          );
    const account = n.options.account(context.actor);
    const users = input.users.length ? input.users : [account.name];
    if (n.source !== "simulated" && input.protocol === "smb")
      for (const user of users) await this.account(user);
    const target = "/srv/everyos-network-shares/" + input.id;
    const recordFile = join(this.directory, input.id + ".json");
    const pinFile = join(this.directory, input.id + ".pin");
    const unitName = "everyos-network-share-" + input.id + ".service";
    const unit = [
      OWNED_HEADER.trimEnd(),
      "[Unit]",
      "Description=EveryOS shared folder",
      "After=local-fs.target",
      "Before=nfs-server.service smbd.service",
      "",
      "[Service]",
      "Type=oneshot",
      "RemainAfterExit=yes",
      "ExecStart=/usr/bin/python3 " +
        unitQuote(join(n.root, "bind-helper.py")) +
        " " +
        unitQuote(pinFile),
      "ExecStop=/bin/umount " + unitQuote(target),
      "TimeoutSec=15",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n");
    const config =
      input.protocol === "nfs"
        ? OWNED_HEADER +
          target +
          " " +
          nfsClients(input.clients)
            .map(
              (client) =>
                client + "(" + nfsOptions(input.readOnly, account.uid, account.gid, input.id) + ")",
            )
            .join(" ") +
          "\n"
        : [
            "[" + input.name + "]",
            "path = " + target,
            "valid users = " + users.join(" "),
            "guest ok = no",
            "read only = " + (input.readOnly ? "yes" : "no"),
            "browseable = no",
            "follow symlinks = no",
            "wide links = no",
            "server smb encrypt = required",
            "create mask = 0600",
            "directory mask = 0700",
            "",
          ].join("\n");
    const record: Stored = {
      owner,
      input,
      ...folder,
      target,
      unit,
      config,
      users,
      uid: account.uid,
      gid: account.gid,
    };
    if (n.source === "simulated") {
      this.#simulated.set(input.id, record);
      return null;
    }
    await n.initialize();
    const previousPin = await privateRead(pinFile);
    const pinText = JSON.stringify({ ...folder, target, readOnly: input.readOnly });
    const unitPath = join(n.unitRoot, unitName);
    const nfsPath = "/etc/exports.d/everyos-" + input.id + ".exports";
    const previousNfs =
      existing?.input.protocol === "nfs" && existing.input.enabled ? existing.config : null;
    const nextNfs = input.enabled ? config : null;
    const previousUnit = await readFile(unitPath, "utf8").catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    });
    if (previousUnit !== (existing?.unit ?? null)) fail("SHARING_CONFIG_CONFLICT");
    if (!existing && mountedTarget(await readFile("/proc/1/mountinfo", "utf8"), target, true))
      fail("SHARING_CONFIG_CONFLICT");
    let pinWritten = false,
      unitWritten = false,
      nfsWritten = false,
      recordWritten = false;
    try {
      if (existing?.input.enabled) {
        if (existing.input.protocol === "smb")
          await n.execute("smbcontrol", ["smbd", "close-share", existing.input.name]);
        if (existing.input.protocol === "nfs") await this.#nfs(existing, false);
        await n.execute("systemctl", ["stop", unitName]);
      }
      for (const path of ["/srv/everyos-network-shares", target]) {
        await mkdir(path, { mode: 0o755 }).catch((e: unknown) => {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        });
        const s = await lstat(path);
        if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) !== 0)
          fail("SHARING_CONFIG_UNSAFE");
      }
      if (
        !existing &&
        ((await readdir(target)).length || (await n.mounted()).some((m) => m.target === target))
      )
        fail("SHARING_CONFIG_CONFLICT");
      await replaceFile(pinFile, pinText, previousPin);
      pinWritten = true;
      await replaceFile(unitPath, unit, existing?.unit ?? null, 0o644);
      unitWritten = true;
      await n.execute("systemctl", ["daemon-reload"]);
      if (input.enabled) await n.execute("systemctl", ["enable", "--now", unitName]);
      else await n.execute("systemctl", ["disable", unitName]);
      if (input.protocol === "nfs") {
        await mkdir("/etc/exports.d", { recursive: true, mode: 0o755 });
        await replaceFile(nfsPath, nextNfs, previousNfs, 0o644);
        nfsWritten = true;
        if (input.enabled) {
          await n.service("nfs", "start");
          await this.#nfs(record, true);
        }
      }
      if (input.protocol === "smb")
        await this.#samba(
          records.filter((r) => r.input.id !== input.id).concat(record),
          input.enabled,
        );
      await replaceFile(
        recordFile,
        JSON.stringify(record),
        existing ? JSON.stringify(existing) : null,
      );
      recordWritten = true;
    } catch (error) {
      if (input.protocol === "nfs" && input.enabled)
        await this.#nfs(record, false).catch(() => undefined);
      await n.execute("systemctl", ["stop", unitName]).catch(() => undefined);
      if (recordWritten)
        await replaceFile(
          recordFile,
          existing ? JSON.stringify(existing) : null,
          JSON.stringify(record),
        ).catch(() => undefined);
      if (nfsWritten)
        await replaceFile(nfsPath, previousNfs, nextNfs, 0o644).catch(() => undefined);
      if (pinWritten) await replaceFile(pinFile, previousPin, pinText).catch(() => undefined);
      if (unitWritten)
        await replaceFile(unitPath, existing?.unit ?? null, unit, 0o644).catch(() => undefined);
      await n.execute("systemctl", ["daemon-reload"]).catch(() => undefined);
      if (existing?.input.enabled) {
        await n.execute("systemctl", ["enable", "--now", unitName]).catch(() => undefined);
        if (existing.input.protocol === "nfs")
          await this.#nfs(existing, true).catch(() => undefined);
      } else await n.execute("systemctl", ["disable", unitName]).catch(() => undefined);
      if (input.protocol === "smb") await this.#samba(records, false).catch(() => undefined);
      throw error;
    }
    return null;
  }
  async #disable(record: Stored, records: Stored[]) {
    const n = this.network,
      disabled = { ...record, input: { ...record.input, enabled: false } };
    if (!record.input.enabled) return disabled;
    if (n.source === "simulated") {
      this.#simulated.set(record.input.id, disabled);
      return disabled;
    }
    const unit = "everyos-network-share-" + record.input.id + ".service";
    if ((await readFile(join(n.unitRoot, unit), "utf8")) !== record.unit)
      fail("SHARING_CONFIG_CONFLICT");
    const nfsPath = "/etc/exports.d/everyos-" + record.input.id + ".exports";
    const recordPath = join(this.directory, record.input.id + ".json");
    let nfsRemoved = false;
    try {
      if (record.input.protocol === "smb") {
        await n.execute("smbcontrol", ["smbd", "close-share", record.input.name]);
        await this.#samba(
          records.filter((r) => r.input.id !== record.input.id),
          false,
        );
      } else {
        await this.#nfs(record, false);
        await replaceFile(nfsPath, null, record.config, 0o644);
        nfsRemoved = true;
      }
      await n.execute("systemctl", ["disable", "--now", unit]);
      await replaceFile(recordPath, JSON.stringify(disabled), JSON.stringify(record));
      return disabled;
    } catch (error) {
      if (nfsRemoved) await replaceFile(nfsPath, record.config, null, 0o644).catch(() => undefined);
      const restored = await n.execute("systemctl", ["enable", "--now", unit]).then(
        () => true,
        () => false,
      );
      if (restored && record.input.protocol === "nfs")
        await this.#nfs(record, true).catch(() => undefined);
      if (record.input.protocol === "smb") await this.#samba(records, false).catch(() => undefined);
      throw error;
    }
  }
  async remove(id: string, context: OperationContext) {
    const n = this.network;
    const records = await this.records();
    const record = records.find((r) => r.input.id === id && r.owner === n.owner(context.actor));
    if (!record) throw new OperationError("not_found", "Share not found");
    if (n.source === "simulated") {
      this.#simulated.delete(id);
      return null;
    }
    // Disable through the same validated transaction first. A later cleanup failure leaves
    // an owned, disabled record that can safely be retried instead of an active orphan export.
    const disabled = await this.#disable(record, records);
    const unit = "everyos-network-share-" + id + ".service";
    const pin = join(this.directory, id + ".pin");
    const files = [
      { path: join(n.unitRoot, unit), text: disabled.unit, mode: 0o644 },
      { path: pin, text: await privateRead(pin), mode: 0o600 },
      { path: join(this.directory, id + ".json"), text: JSON.stringify(disabled), mode: 0o600 },
    ];
    const removed: typeof files = [];
    try {
      for (const f of files) {
        await replaceFile(f.path, null, f.text, f.mode);
        removed.push(f);
      }
      await n.execute("systemctl", ["daemon-reload"]);
    } catch (error) {
      for (const f of removed.reverse())
        await replaceFile(f.path, f.text, null, f.mode).catch(() => undefined);
      await n.execute("systemctl", ["daemon-reload"]).catch(() => undefined);
      throw error;
    }
    return null;
  }
}
