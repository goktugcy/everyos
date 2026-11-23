import { readFile, readdir, mkdir, lstat, chown, chmod } from "node:fs/promises";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import {
  OperationError,
  type Actor,
  type OperationContext,
  type OperationHandlers,
} from "@everyos/agent-protocol";
import {
  networkRootId,
  roleHasPermission,
  type LinuxAccount,
  type SharingHostStatus,
  type SharingServiceStatus,
} from "@everyos/shared";
import { AgentMountInputSchema, SharingIdSchema } from "@everyos/shared/schemas";
import { findExecutable, runCapture, type AptManager } from "@everyos/system";
import type { SecretBox } from "@everyos/security";
import { z } from "zod";
import {
  fail,
  mountAddress,
  mountUnits,
  mountedTarget,
  parseNetworkMounts,
  privateDirectory,
  privateRead,
  reachable,
  replaceFile,
  type MountInput,
} from "./network-sharing-files.ts";
import { NetworkExports } from "./network-sharing-exports.ts";

export type NetworkExecute = (
  tool: string,
  args: readonly string[],
  input?: string,
  signal?: AbortSignal,
) => Promise<string>;
export const networkExecute: NetworkExecute = async (name, args, input, signal) => {
  const tool = await findExecutable(name, { refresh: true });
  if (!tool) throw new OperationError("unsupported", "SHARING_DEPENDENCY_MISSING");
  const result = await runCapture(tool, args, {
    timeoutMs: 20000,
    maxOutputBytes: 256 * 1024,
    ...(input === undefined ? {} : { input }),
    ...(signal ? { signal } : {}),
  });
  if (result.exitCode !== 0) throw new OperationError("failed", "SHARING_COMMAND_FAILED");
  return result.output;
};
const StoredMount = z.strictObject({
  owner: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  input: AgentMountInputSchema,
  target: z.string().max(2048),
  uid: z.number().int().min(1),
  gid: z.number().int().nonnegative(),
  sealed: z.string().nullable(),
  mount: z.string(),
  automount: z.string(),
});
type Stored = z.infer<typeof StoredMount>;
const recipes = {
  nfs: { binary: "exportfs", unit: "nfs-server.service" },
  smb: { binary: "smbd", unit: "smbd.service" },
  sftp: { binary: "sshd", unit: "ssh.service" },
  discovery: { binary: "avahi-browse", unit: "avahi-daemon.service" },
  "nfs-client": { binary: "mount.nfs", unit: null },
  "smb-client": { binary: "mount.cifs", unit: null },
} as const;

export class NetworkSharing {
  readonly source: "host" | "simulated";
  readonly root: string;
  readonly mountRoot: string;
  readonly runtime: string;
  readonly unitRoot: string;
  readonly execute: NetworkExecute;
  readonly exports: NetworkExports;
  readonly options: {
    secrets: SecretBox;
    apt: AptManager;
    simulate?: boolean;
    root?: string;
    mountRoot?: string;
    runtime?: string;
    unitRoot?: string;
    account: (actor: Actor) => LinuxAccount;
    inspect: (
      params: { root: string; path: string; readOnly: boolean },
      context: OperationContext,
    ) => Promise<{ path: string; device: number; inode: number }>;
    requirePrivilege?: (actor: Actor) => Promise<void>;
    execute?: NetworkExecute;
    supported?: boolean;
  };
  #busy = false;
  #rootRecords: { at: number; records: Stored[] } | null = null;
  #installation: SharingHostStatus["installation"] = null;
  #simulated = new Map<string, Stored>();
  #simMounted = new Set<string>();
  constructor(options: NetworkSharing["options"]) {
    this.options = options;
    this.source = options.simulate ? "simulated" : "host";
    this.root = options.root ?? "/var/lib/everyos-agent/network";
    this.mountRoot = options.mountRoot ?? "/mnt/everyos-network";
    this.runtime = options.runtime ?? "/run/everyos-network";
    this.unitRoot = options.unitRoot ?? "/etc/systemd/system";
    this.execute = options.execute ?? networkExecute;
    this.exports = new NetworkExports(this);
  }
  get supported() {
    return (
      this.options.supported ??
      (process.platform === "linux" && ["arm64", "x64"].includes(process.arch))
    );
  }
  owner(actor: Actor) {
    if (actor.kind !== "user" || !/^[A-Za-z0-9_-]{1,64}$/.test(actor.userId))
      throw new OperationError("forbidden", "User required");
    return actor.userId;
  }
  async initialize() {
    if (!this.supported || this.source === "simulated") return;
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, "mounts"));
    await privateDirectory(this.runtime);
    for (const record of await this.records()) await this.credentials(record);
    await this.exports.initialize();
  }
  async records(): Promise<Stored[]> {
    if (this.source === "simulated") return [...this.#simulated.values()];
    const names = await readdir(join(this.root, "mounts")).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const records: Stored[] = [];
    for (const name of names.filter((n) => /^[a-f0-9-]{36}\.json$/.test(n)).slice(0, 256)) {
      const text = await privateRead(join(this.root, "mounts", name));
      if (text) {
        const value = StoredMount.parse(JSON.parse(text));
        if (
          value.target !==
          join(this.mountRoot, value.owner, value.input.mountName || networkRootId(value.input.id))
        )
          fail("SHARING_CONFIG_UNSAFE");
        records.push(value);
      }
    }
    return records;
  }
  async record(id: string, actor: Actor) {
    SharingIdSchema.parse(id);
    const record = (await this.records()).find(
      (r) => r.input.id === id && r.owner === this.owner(actor),
    );
    if (!record) throw new OperationError("not_found", "Network connection not found");
    return record;
  }
  /** Account workers receive only their owner's actually mounted roots through the private pipe. */
  fileRoots(actor: Actor) {
    const owner = this.owner(actor);
    const roots = [];
    if (!this.#rootRecords || Date.now() - this.#rootRecords.at > 1000) {
      let names: string[];
      try {
        names = readdirSync(join(this.root, "mounts"));
      } catch {
        return [];
      }
      const records: Stored[] = [];
      for (const name of names.filter((v) => /^[a-f0-9-]{36}\.json$/.test(v)).slice(0, 256)) {
        const path = join(this.root, "mounts", name);
        const s = lstatSync(path);
        if (
          !s.isFile() ||
          s.isSymbolicLink() ||
          s.uid !== 0 ||
          s.size > 256 * 1024 ||
          s.mode & 0o077
        )
          fail("SHARING_CONFIG_UNSAFE");
        const r = StoredMount.parse(JSON.parse(readFileSync(path, "utf8")));
        records.push(r);
      }
      this.#rootRecords = { at: Date.now(), records };
    }
    if (!this.#rootRecords.records.some((r) => r.owner === owner && r.input.enabled)) return [];
    const account = this.options.account(actor);
    const mounted = parseNetworkMounts(readFileSync("/proc/1/mountinfo", "utf8"));
    for (const r of this.#rootRecords.records) {
      if (r.owner !== owner || !r.input.enabled || r.uid !== account.uid || r.gid !== account.gid)
        continue;
      const expected = join(this.mountRoot, owner, r.input.mountName || networkRootId(r.input.id));
      if (r.target !== expected) fail("SHARING_CONFIG_UNSAFE");
      const actual = mounted.find((m) => m.target === r.target && m.protocol === r.input.protocol);
      const source = mountUnits(
        r.input,
        r.target,
        join(this.runtime, r.input.id + ".credentials"),
        r.uid,
        r.gid,
      ).source;
      if (actual?.source === source)
        roots.push({
          id: networkRootId(r.input.id),
          name: r.input.name,
          path: r.target,
          readOnly: r.input.readOnly || actual.readOnly,
          kind: "network" as const,
        });
    }
    return roots;
  }
  async credentials(record: Stored) {
    if (record.input.protocol !== "smb" || !record.sealed) return;
    const data = z
      .strictObject({ username: z.string(), password: z.string(), domain: z.string() })
      .parse(
        JSON.parse(
          this.options.secrets.open(
            record.sealed,
            "network:" + record.owner + ":" + record.input.id,
          ),
        ),
      );
    if ([data.username, data.password, data.domain].some((v) => /[\0\r\n]/.test(v)))
      fail("SHARING_CONFIG_UNSAFE");
    const target = join(this.runtime, record.input.id + ".credentials");
    await replaceFile(
      target,
      "username=" +
        data.username +
        "\npassword=" +
        data.password +
        "\ndomain=" +
        data.domain +
        "\n",
      await privateRead(target),
    );
  }
  async exclusive<T>(run: () => Promise<T>) {
    if (this.#busy || this.#installation?.state === "running")
      throw new OperationError("busy", "SHARING_BUSY");
    this.#busy = true;
    this.#rootRecords = null;
    try {
      return await run();
    } finally {
      this.#rootRecords = null;
      this.#busy = false;
    }
  }
  async mounted() {
    return parseNetworkMounts(await readFile("/proc/1/mountinfo", "utf8").catch(() => ""));
  }
  async status(actor: Actor): Promise<SharingHostStatus> {
    const owner = this.owner(actor);
    const supported = this.supported;
    const installSupported =
      supported &&
      /^(ID=|ID_LIKE=).*\b(?:debian|ubuntu)\b/m.test(
        await readFile("/etc/os-release", "utf8").catch(() => ""),
      );
    const services = await Promise.all(
      Object.entries(recipes).map(async ([protocol, recipe]): Promise<SharingServiceStatus> => {
        const installed =
          this.source === "simulated" ||
          Boolean(
            supported &&
            (await findExecutable(recipe.binary, { refresh: true })) &&
            (!["nfs", "smb"].includes(protocol) ||
              (await findExecutable("python3", { refresh: true }))) &&
            (protocol !== "discovery" || (await findExecutable("avahi-daemon", { refresh: true }))),
          );
        const active =
          installed &&
          recipe.unit !== null &&
          (this.source === "simulated" ||
            (recipe.unit !== null &&
              (await this.execute("systemctl", ["is-active", recipe.unit]).then(
                (v) => v.trim() === "active",
                () => false,
              ))));
        return {
          protocol: protocol as SharingServiceStatus["protocol"],
          installed,
          active,
          installSupported: installSupported || this.source === "simulated",
        };
      }),
    );
    const ssh = services.find((s) => s.protocol === "sftp");
    if (ssh?.installed && !ssh.active && this.source === "host")
      ssh.active = await this.execute("systemctl", ["is-active", "ssh.socket"]).then(
        (v) => v.trim() === "active",
        () => false,
      );
    const records = (await this.records()).filter((r) => r.owner === owner);
    const mounted = this.source === "simulated" ? [] : await this.mounted();
    const mounts: SharingHostStatus["mounts"] = records.map((r) => {
      const actual = mounted.find((m) => m.target === r.target);
      return {
        id: r.input.id,
        owner,
        protocol: r.input.protocol,
        source: mountUnits(
          r.input,
          r.target,
          join(this.runtime, r.input.id + ".credentials"),
          r.uid,
          r.gid,
        ).source,
        target: r.target,
        readOnly: actual?.readOnly ?? r.input.readOnly,
        mounted:
          (actual?.protocol === r.input.protocol &&
            actual.source ===
              mountUnits(
                r.input,
                r.target,
                join(this.runtime, r.input.id + ".credentials"),
                r.uid,
                r.gid,
              ).source) ||
          this.#simMounted.has(r.input.id),
        managed: true,
        reachable: null,
      };
    });
    if (actor.kind === "user" && roleHasPermission(actor.role, "system:manage"))
      mounts.push(
        ...mounted
          .filter((m) => !mounts.some((r) => r.target === m.target))
          .map((m) => ({
            ...m,
            id: null,
            owner: null,
            managed: false,
            mounted: true,
            reachable: null,
          })),
      );
    const addresses = Object.values(networkInterfaces())
      .flatMap((v) => v ?? [])
      .filter((v) => !v.internal && !(v.family === "IPv6" && /^fe[89ab]/i.test(v.address)))
      .map((v) => v.address)
      .slice(0, 64);
    const hostMounts =
      this.source === "simulated"
        ? ""
        : await readFile("/proc/1/mountinfo", "utf8").catch(() => "");
    const exports = (await this.exports.records())
      .filter((r) => r.owner === owner)
      .map((r) => ({
        id: r.input.id,
        active:
          r.input.enabled &&
          (this.source === "simulated" ||
            hostMounts.split("\n").some((line) => line.split(" ")[4] === r.target)) &&
          services.some((s) => s.protocol === r.input.protocol && s.active),
      }));
    const admin = actor.kind === "user" && roleHasPermission(actor.role, "system:manage");
    const [sshConfig, exportList] =
      this.source === "host" && supported
        ? await Promise.all([
            this.execute("sshd", ["-T"]).catch(() => ""),
            admin ? this.execute("exportfs", ["-s"]).catch(() => "") : Promise.resolve(""),
          ])
        : ["", ""];
    const sshPorts = [
      ...new Set([...sshConfig.matchAll(/^port (\d+)$/gm)].map((m) => Number(m[1]))),
    ].slice(0, 16);
    const externalExports = exportList
      .split("\n")
      .flatMap((line) => {
        const m = /^(\/[^\s]+)\s+([^\s(]+)\(/.exec(line.trim());
        return m && !m[1]!.startsWith("/srv/everyos-network-shares/")
          ? [{ path: m[1]!, client: m[2]! }]
          : [];
      })
      .slice(0, 256);
    return {
      exports,
      externalExports,
      sshPorts,
      source: this.source,
      supported: supported || this.source === "simulated",
      services,
      mounts,
      addresses,
      reason: supported || this.source === "simulated" ? null : "SHARING_LINUX_REQUIRED",
      installation: this.#installation,
    };
  }
  async apply(input: MountInput, context: OperationContext) {
    if (!this.supported && this.source !== "simulated")
      throw new OperationError("unsupported", "SHARING_LINUX_REQUIRED");
    input = AgentMountInputSchema.parse(input);
    if (this.source !== "simulated") input = { ...input, host: await mountAddress(input.host) };
    return this.exclusive(async () => {
      const owner = this.owner(context.actor);
      const account = this.options.account(context.actor);
      const existing = (await this.records()).find((r) => r.input.id === input.id);
      if (existing && existing.owner !== owner)
        throw new OperationError("forbidden", "Connection owner mismatch");
      if (existing && existing.input.protocol !== input.protocol) fail("SHARING_PROTOCOL_SETTINGS");
      if ((await this.records()).length >= 256 && !existing)
        throw new OperationError("busy", "SHARING_LIMIT");
      if (input.protocol === "smb" && !input.password && !existing?.sealed)
        fail("SHARING_CREDENTIAL_REQUIRED");
      const target = join(this.mountRoot, owner, input.mountName || networkRootId(input.id));
      if ((await this.records()).some((r) => r.target === target && r.input.id !== input.id))
        fail("SHARING_CONFIG_CONFLICT");
      if (existing && existing.target !== target) fail("SHARING_CONFIG_CONFLICT");
      const unit = mountUnits(
        input,
        target,
        join(this.runtime, input.id + ".credentials"),
        account.uid,
        account.gid,
      );
      const sealed = input.password
        ? this.options.secrets.seal(
            JSON.stringify({
              username: input.username,
              password: input.password,
              domain: input.domain ?? "",
            }),
            "network:" + owner + ":" + input.id,
          )
        : (existing?.sealed ?? null);
      const { password: _password, domain: _domain, ...publicInput } = input;
      const record: Stored = {
        owner,
        input: publicInput,
        target,
        uid: account.uid,
        gid: account.gid,
        sealed,
        mount: unit.mount,
        automount: unit.automount,
      };
      if (this.source === "simulated") {
        this.#simulated.set(input.id, record);
        return { target };
      }
      await this.initialize();
      for (const path of [this.mountRoot, join(this.mountRoot, owner)]) {
        await mkdir(path, { recursive: true, mode: 0o711 });
        const s = await lstat(path);
        if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) !== 0)
          fail("SHARING_CONFIG_UNSAFE");
        await chmod(path, 0o711);
      }
      const actual = (await this.mounted()).find((m) => m.target === target);
      if (!existing && mountedTarget(await readFile("/proc/1/mountinfo", "utf8"), target, true))
        fail("SHARING_EXTERNAL_MOUNT");
      const mountPath = join(this.unitRoot, unit.name + ".mount");
      const autoPath = join(this.unitRoot, unit.name + ".automount");
      for (const [path, expected] of [
        [mountPath, existing?.mount ?? null],
        [autoPath, existing?.automount ?? null],
      ] as const) {
        const current = await readFile(path, "utf8").catch((e: unknown) => {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw e;
        });
        if (current !== expected) fail("SHARING_CONFIG_CONFLICT");
      }
      let disconnected = false,
        mountWritten = false,
        autoWritten = false;
      try {
        if (existing) {
          await this.control(existing.input.id, "disconnect", context.actor);
          disconnected = true;
        }
        await mkdir(target, { mode: 0o700 }).catch((e: unknown) => {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        });
        const targetInfo = await lstat(target);
        if (
          !targetInfo.isDirectory() ||
          targetInfo.isSymbolicLink() ||
          (!existing &&
            ((targetInfo.uid !== 0 && targetInfo.uid !== account.uid) ||
              (await readdir(target)).length))
        )
          fail("SHARING_CONFIG_UNSAFE");
        await chown(target, account.uid, account.gid);
        await this.credentials(record);
        await replaceFile(mountPath, unit.mount, existing?.mount ?? null, 0o644);
        mountWritten = true;
        await replaceFile(autoPath, unit.automount, existing?.automount ?? null, 0o644);
        autoWritten = true;
        const path = join(this.root, "mounts", input.id + ".json");
        await replaceFile(path, JSON.stringify(record), existing ? JSON.stringify(existing) : null);
        await this.execute("systemctl", ["daemon-reload"]);
        if (input.enabled && input.persistent)
          await this.execute("systemctl", ["enable", unit.name + ".automount"]);
        else await this.execute("systemctl", ["disable", unit.name + ".automount"]);
        if (input.enabled && input.automount)
          await this.execute("systemctl", ["start", unit.name + ".automount"]);
      } catch (error) {
        const path = join(this.root, "mounts", input.id + ".json");
        const written = await privateRead(path).catch(() => null);
        if (written === JSON.stringify(record))
          await replaceFile(path, existing ? JSON.stringify(existing) : null, written).catch(
            () => undefined,
          );
        if (disconnected || mountWritten || autoWritten)
          await this.execute("systemctl", [
            "stop",
            unit.name + ".automount",
            unit.name + ".mount",
          ]).catch(() => undefined);
        if (existing) await this.credentials(existing).catch(() => undefined);
        else {
          const credentialPath = join(this.runtime, input.id + ".credentials");
          await replaceFile(credentialPath, null, await privateRead(credentialPath)).catch(
            () => undefined,
          );
        }
        if (mountWritten)
          await replaceFile(mountPath, existing?.mount ?? null, unit.mount, 0o644).catch(
            () => undefined,
          );
        if (autoWritten)
          await replaceFile(autoPath, existing?.automount ?? null, unit.automount, 0o644).catch(
            () => undefined,
          );
        await this.execute("systemctl", ["daemon-reload"]).catch(() => undefined);
        if (existing && disconnected) {
          await this.execute("systemctl", [
            existing.input.enabled && existing.input.persistent ? "enable" : "disable",
            unit.name + ".automount",
          ]).catch(() => undefined);
          if (existing.input.enabled && existing.input.automount)
            await this.execute("systemctl", ["start", unit.name + ".automount"]).catch(
              () => undefined,
            );
          if (actual)
            await this.control(existing.input.id, "connect", context.actor).catch(() => undefined);
        } else if (!existing)
          await this.execute("systemctl", ["disable", unit.name + ".automount"]).catch(
            () => undefined,
          );
        throw error;
      }
      return { target };
    });
  }
  async control(id: string, action: "connect" | "disconnect", actor: Actor, verifyAccount = true) {
    const record = await this.record(id, actor);
    if (verifyAccount) {
      const account = this.options.account(actor);
      if (account.uid !== record.uid || account.gid !== record.gid)
        throw new OperationError("policy_denied", "LINUX_ACCOUNT_CHANGED");
    } else if (action !== "disconnect")
      throw new OperationError("forbidden", "Only identity cleanup can skip account resolution");
    if (this.source === "simulated") {
      if (action === "connect") this.#simMounted.add(id);
      else this.#simMounted.delete(id);
      return null;
    }
    const unit = mountUnits(
      record.input,
      record.target,
      join(this.runtime, id + ".credentials"),
      record.uid,
      record.gid,
    );
    const actual = (await this.mounted()).find((m) => m.target === record.target);
    if (
      (!actual && mountedTarget(await readFile("/proc/1/mountinfo", "utf8"), record.target)) ||
      (actual && (actual.protocol !== record.input.protocol || actual.source !== unit.source))
    )
      fail("SHARING_EXTERNAL_MOUNT");
    const unitName = unit.name;
    if (
      (await readFile(join(this.unitRoot, unitName + ".mount"), "utf8")) !== record.mount ||
      (await readFile(join(this.unitRoot, unitName + ".automount"), "utf8")) !== record.automount
    )
      fail("SHARING_CONFIG_CONFLICT");
    if (action === "connect") {
      if (!record.input.enabled) fail("SHARING_DISABLED");
      if (!(await reachable(record.input.host, record.input.port))) fail("SHARING_UNREACHABLE");
      await this.credentials(record);
      await this.execute("systemctl", ["reset-failed", unitName + ".mount"]).catch(() => undefined);
      await this.execute("systemctl", ["start", unitName + ".mount"]);
    } else {
      await this.execute("systemctl", ["stop", unitName + ".automount", unitName + ".mount"]);
    }
    return null;
  }
  async remove(id: string, actor: Actor, identityCleanup = false) {
    const run = async () => {
      const r = await this.record(id, actor);
      await this.control(id, "disconnect", actor, !identityCleanup);
      if (this.source === "simulated") {
        this.#simulated.delete(id);
        return null;
      }
      const name = mountUnits(
        r.input,
        r.target,
        join(this.runtime, id + ".credentials"),
        r.uid,
        r.gid,
      ).name;
      const files = [
        { path: join(this.unitRoot, name + ".mount"), text: r.mount, mode: 0o644 },
        { path: join(this.unitRoot, name + ".automount"), text: r.automount, mode: 0o644 },
        {
          path: join(this.runtime, id + ".credentials"),
          text: await privateRead(join(this.runtime, id + ".credentials")),
          mode: 0o600,
        },
        { path: join(this.root, "mounts", id + ".json"), text: JSON.stringify(r), mode: 0o600 },
      ];
      const removed: typeof files = [];
      try {
        await this.execute("systemctl", ["disable", name + ".automount"]);
        for (const f of files) {
          await replaceFile(f.path, null, f.text, f.mode);
          removed.push(f);
        }
        await this.execute("systemctl", ["daemon-reload"]);
      } catch (error) {
        for (const f of removed.reverse())
          await replaceFile(f.path, f.text, null, f.mode).catch(() => undefined);
        await this.execute("systemctl", ["daemon-reload"]).catch(() => undefined);
        if (r.input.enabled && r.input.persistent)
          await this.execute("systemctl", ["enable", name + ".automount"]).catch(() => undefined);
        throw error;
      }
      return null;
    };
    return identityCleanup ? run() : this.exclusive(run);
  }
  async cleanupOwner(userId: string, context: OperationContext) {
    if (context.actor.kind !== "user" || !roleHasPermission(context.actor.role, "users:manage"))
      throw new OperationError("forbidden", "User administration required");
    SharingIdSchema.parse(userId);
    const mounts = (await this.records()).filter((r) => r.owner === userId),
      exports = (await this.exports.records()).filter((r) => r.owner === userId);
    if (!mounts.length && !exports.length) return;
    if (this.source !== "simulated") {
      if (!this.options.requirePrivilege)
        throw new OperationError("policy_denied", "LINUX_SUDO_REQUIRED");
      await this.options.requirePrivilege(context.actor);
    }
    const ownerActor = { ...context.actor, userId };
    for (const r of mounts) {
      if (context.signal.aborted)
        throw new OperationError("cancelled", "Identity cleanup cancelled");
      await this.remove(r.input.id, ownerActor, true);
    }
    for (const r of exports) {
      if (context.signal.aborted)
        throw new OperationError("cancelled", "Identity cleanup cancelled");
      await this.exports.remove(r.input.id, { ...context, actor: ownerActor });
    }
  }
  async service(protocol: "nfs" | "smb" | "sftp" | "discovery", action: "start" | "reload") {
    if (this.source !== "simulated")
      await this.execute("systemctl", [action, recipes[protocol].unit]);
    return null;
  }
  install(protocol: keyof typeof recipes) {
    if (this.#busy || this.#installation?.state === "running")
      throw new OperationError("busy", "SHARING_BUSY");
    if (this.source !== "simulated" && !this.options.apt.installSharing)
      throw new OperationError("unsupported", "SHARING_INSTALL_UNSUPPORTED");
    this.#installation = { state: "running", protocol, reason: null };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25 * 60_000);
    timer.unref();
    const run = async () => {
      if (this.source === "simulated") return;
      const refreshed = await this.options.apt.refresh(controller.signal);
      if (!refreshed.ok) fail("SHARING_PACKAGE_REFRESH_FAILED");
      const result = await this.options.apt.installSharing!(protocol, controller.signal);
      if (!result.ok) fail(result.busy ? "SHARING_PACKAGE_BUSY" : "SHARING_INSTALL_FAILED");
    };
    void run()
      .then(
        () => {
          this.#installation = { state: "succeeded", protocol, reason: null };
        },
        () => {
          this.#installation = { state: "failed", protocol, reason: "SHARING_INSTALL_FAILED" };
        },
      )
      .finally(() => clearTimeout(timer));
    return null;
  }
  async discover() {
    if (this.source === "simulated") return { available: false, services: [] };
    if (!(await findExecutable("avahi-browse"))) return { available: false, services: [] };
    const result = [];
    for (const [type, protocol] of [
      ["_smb._tcp", "smb"],
      ["_nfs._tcp", "nfs"],
      ["_sftp-ssh._tcp", "sftp"],
    ] as const) {
      const output = await this.execute("avahi-browse", [
        "--resolve",
        "--terminate",
        "--parsable",
        "--no-db-lookup",
        type,
      ]).catch(() => "");
      for (const line of output.split("\n")) {
        const p = line.split(";");
        if (p[0] !== "=" || !p[3] || !p[7] || !p[8]) continue;
        const port = Number(p[8]);
        if (Number.isInteger(port) && port > 0 && port < 65536)
          result.push({ name: p[3].slice(0, 256), host: p[7].slice(0, 256), port, protocol });
      }
    }
    return { available: true, services: result.slice(0, 100) };
  }
}
export function networkSharingHandlers(
  network: NetworkSharing,
): Pick<OperationHandlers, Extract<keyof OperationHandlers, `sharing.${string}`>> {
  return {
    "sharing.status": (_p, c) => network.status(c.actor),
    "sharing.mount.apply": (p, c) => network.apply(p, c),
    "sharing.mount.control": (p, c) =>
      network.exclusive(() => network.control(p.id, p.action, c.actor)),
    "sharing.mount.access": async (p, c) => {
      const record = await network.record(p.id, c.actor);
      if (!record.input.enabled || !record.input.automount) fail("SHARING_DISABLED");
      return network.exclusive(() => network.control(p.id, "connect", c.actor));
    },
    "sharing.mount.remove": (p, c) => network.remove(p.id, c.actor),
    "sharing.export.apply": (p, c) => network.exclusive(() => network.exports.apply(p, c)),
    "sharing.export.remove": (p, c) => network.exclusive(() => network.exports.remove(p.id, c)),
    "sharing.service": (p) => network.exclusive(() => network.service(p.protocol, p.action)),
    "sharing.install": (p) => network.install(p.protocol),
    "sharing.smb.account": (p, c) =>
      network.exclusive(() => network.exports.smbAccount(p.username, p.password, c)),
    "sharing.discover": () => network.discover(),
  };
}
