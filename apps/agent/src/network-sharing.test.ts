import { mkdtemp, chmod, lstat, readFile, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SecretBox } from "@everyos/security";
import { networkRootId } from "@everyos/shared";
import { silentLogger } from "@everyos/logger";
import { AGENT_OPERATIONS, type OperationContext } from "@everyos/agent-protocol";
import { AgentMountInputSchema, SharingConnectionInputSchema } from "@everyos/shared/schemas";
import type { AptManager } from "@everyos/system";
import {
  SAMBA_INCLUDE,
  amendConfig,
  mountAddress,
  mountedTarget,
  mountUnits,
  parseNetworkMounts,
  privateRead,
  replaceFile,
} from "./network-sharing-files.ts";
import { nfsClients, nfsOptions, nfsTarget } from "./network-sharing-exports.ts";
import { NetworkSharing, networkSharingHandlers } from "./network-sharing.ts";
import { createPolicy } from "./policy.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const context: OperationContext = {
  actor: { kind: "user", userId: randomUUID(), username: "fixture", role: "admin" },
  signal: new AbortController().signal,
  logger: silentLogger,
};
const mount = () =>
  AgentMountInputSchema.parse({
    id: randomUUID(),
    name: "Research",
    protocol: "nfs",
    host: "192.168.10.5",
    port: 2049,
    remotePath: "/data",
    username: "",
    readOnly: true,
    enabled: true,
    persistent: true,
    automount: true,
    version: "4.2",
  });

describe("native network sharing safety contracts (no host services changed)", () => {
  it("preserves full connection identities within the existing Files root limit", () => {
    const a = networkRootId("29c6f8ee-7500-48ca-b826-34b676a9ef66"),
      b = networkRootId("29c6f8ee-7500-48ca-b826-34b676a9ef67");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^net-[a-z0-9]{25}$/);
    expect(a.length).toBeLessThanOrEqual(32);
  });
  it("cleans only the target owner's native resources before unlinking an identity", async () => {
    let available = true;
    const network = new NetworkSharing({
      simulate: true,
      supported: false,
      secrets: new SecretBox(Buffer.alloc(32, 8)),
      apt: {} as AptManager,
      account: () => {
        if (!available) throw new Error("Account already gone");
        return { name: "fixture", uid: 1001, gid: 1001, home: "/home/fixture", shell: "/bin/sh" };
      },
      inspect: () => {
        throw new Error("Simulation never inspects the host");
      },
    });
    const own = mount(),
      other = mount(),
      second: OperationContext = {
        ...context,
        actor: { kind: "user", role: "admin", username: "second", userId: randomUUID() },
      };
    await network.apply(own, context);
    await network.apply(other, second);
    const id = randomUUID();
    await network.exports.apply(
      {
        id,
        name: "Owned",
        protocol: "nfs",
        root: "fixture",
        path: "data",
        clients: ["192.168.1.0/24"],
        users: [],
        readOnly: true,
        enabled: true,
        confirm: true,
      },
      context,
    );
    const record = (await network.exports.records()).find((r) => r.input.id === id)!;
    expect(record.unit).toContain("Before=nfs-server.service smbd.service");
    available = false;
    await network.exclusive(() =>
      network.cleanupOwner((context.actor as { userId: string }).userId, context),
    );
    expect((await network.records()).map((r) => r.input.id)).toEqual([other.id]);
    expect(await network.exports.records()).toEqual([]);
    await expect(
      network.cleanupOwner((second.actor as { userId: string }).userId, {
        ...second,
        actor: {
          ...second.actor,
          kind: "user",
          userId: randomUUID(),
          username: "operator",
          role: "operator",
        },
      }),
    ).rejects.toThrow("User administration required");
  });
  it("uses lazy boot units and bounded mount startup without unsafe NFS soft mounts", () => {
    const input = mount(),
      rendered = mountUnits(
        input,
        "/mnt/everyos-network/person/research",
        "/run/private",
        1001,
        1001,
      );
    expect(rendered.mount).toContain("hard,timeo=50,retrans=2,retry=0");
    expect(rendered.mount).toContain("TimeoutSec=12");
    expect(rendered.mount).toContain("nosuid,nodev,noexec,_netdev,ro");
    expect(rendered.mount).not.toContain("[Install]");
    expect(rendered.automount).toContain("WantedBy=multi-user.target");
    expect(rendered.automount).not.toContain("network-online.target");
    expect(rendered.automount).toContain("TimeoutIdleSec=120");
    expect(rendered.name).toBe("mnt-everyos\\x2dnetwork-person-research");
    for (const version of ["4.1", "4", "3"] as const)
      expect(mountUnits({ ...input, version }, "/mnt/x", "/run/c", 1001, 1001).mount).toContain(
        "vers=" + version,
      );
  });
  it("keeps CIFS secrets out of units and seals SMB3 while rejecting SMB1 and option injection", () => {
    const input = {
      ...mount(),
      protocol: "smb" as const,
      remotePath: "Shared Data",
      port: 445,
      version: "3.1.1" as const,
      username: "owner",
      password: "not-in-units",
      readOnly: false,
    };
    const rendered = mountUnits(input, "/mnt/x", "/run/secret-file", 1001, 1002);
    expect(rendered.mount).toContain("credentials=/run/secret-file");
    expect(rendered.mount).toContain("uid=1001,gid=1002");
    expect(rendered.mount).toContain("nodfs,forceuid,forcegid,seal");
    expect(rendered.mount).not.toContain(input.password);
    expect(() =>
      mountUnits({ ...input, remotePath: "share,guest" }, "/mnt/x", "/run/c", 1, 1),
    ).toThrow();
    expect(AgentMountInputSchema.safeParse({ ...input, version: "1.0" }).success).toBe(false);
    expect(
      SharingConnectionInputSchema.safeParse({ ...input, confirm: true, mountName: "../../etc" })
        .success,
    ).toBe(false);
  });
  it("refuses adopting external automounts while recognizing owned on-demand placeholders", () => {
    const info = "25 1 0:2 / /mnt/share rw - autofs systemd-1 rw";
    expect(mountedTarget(info, "/mnt/share")).toBe(false);
    expect(mountedTarget(info, "/mnt/share", true)).toBe(true);
  });
  it("decodes actual mountinfo and leaves unrelated file systems out", () => {
    const parsed = parseNetworkMounts(
      "25 1 0:2 / /mnt/Shared\\040Data ro,relatime - nfs4 192.168.1.2:/data rw\n26 1 0:3 / /mnt/smb rw - cifs //192.168.1.3/share rw\n27 1 8:1 / / rw - ext4 /dev/sda1 rw",
    );
    expect(parsed).toEqual([
      { protocol: "nfs", source: "192.168.1.2:/data", target: "/mnt/Shared Data", readOnly: true },
      { protocol: "smb", source: "//192.168.1.3/share", target: "/mnt/smb", readOnly: false },
    ]);
  });
  it("requires explicit valid NFS networks and maps all clients to the authorized Linux account", () => {
    expect(nfsClients(["192.168.1.0/24", "fd00::/64", "192.168.1.0/24"])).toEqual([
      "192.168.1.0/24",
      "fd00::/64",
    ]);
    for (const clients of [
      [],
      ["*"],
      ["0.0.0.0/0"],
      ["::/0"],
      ["192.168.1.1/33"],
      ["fd00::/129"],
      ["192.168.999.1"],
    ])
      expect(() => nfsClients(clients)).toThrow();
    expect(nfsOptions(false, 1001, 1002, "29c6f8ee-7500-48ca-b826-34b676a9ef66")).toContain(
      "root_squash,all_squash,anonuid=1001,anongid=1002",
    );
    expect(nfsTarget("fd00::/64", "/srv/share")).toBe("[fd00::]/64:/srv/share");
    expect(nfsTarget("fd00::12", "/srv/share")).toBe("[fd00::12]:/srv/share");
    expect(nfsOptions(false, 1001, 1002, "29c6f8ee-7500-48ca-b826-34b676a9ef66")).toContain(
      "subtree_check,fsid=29c6f8ee-7500-48ca-b826-34b676a9ef66",
    );
    expect(nfsOptions(true, 1001, 1002, "29c6f8ee-7500-48ca-b826-34b676a9ef66")).toMatch(
      /^ro,sync,/,
    );
    expect(nfsOptions(false, 1001, 1002, "29c6f8ee-7500-48ca-b826-34b676a9ef66")).not.toContain(
      "no_root_squash",
    );
  });
  it("atomically changes only owned bytes and refuses symlinks, permissive secrets and changed files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "everyos-native-contract-"));
    directories.push(directory);
    const path = join(directory, "credentials");
    await replaceFile(path, "first", null);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect(replaceFile(path, "bad", "stale")).rejects.toThrow("SHARING_CONFIG_CONFLICT");
    expect(await readFile(path, "utf8")).toBe("first");
    await replaceFile(path, "second", "first");
    await symlink(path, join(directory, "link"));
    await expect(replaceFile(join(directory, "link"), "bad", "second")).rejects.toThrow();
    await chmod(path, 0o644);
    await expect(privateRead(path)).rejects.toThrow("SHARING_CONFIG_UNSAFE");
  });
  it("preserves the Samba administrator inode and mode while appending or rolling back only the include", async () => {
    const directory = await mkdtemp(join(tmpdir(), "everyos-samba-contract-"));
    directories.push(directory);
    const path = join(directory, "smb.conf"),
      original = "[global]\n  workgroup = PERSONAL\n# ğ ü\n",
      next = original + "\n" + SAMBA_INCLUDE;
    await writeFile(path, original, { mode: 0o640 });
    const before = await lstat(path);
    await amendConfig(path, next, original);
    const after = await lstat(path);
    expect(after.ino).toBe(before.ino);
    expect(after.mode).toBe(before.mode);
    expect(await readFile(path, "utf8")).toBe(next);
    await expect(amendConfig(path, "[global]\n", next)).rejects.toThrow();
    await amendConfig(path, original, next);
    expect(await readFile(path, "utf8")).toBe(original);
    await writeFile(path, original + "# administrator edit\n");
    await expect(amendConfig(path, next, original)).rejects.toThrow();
  });
  it("blocks local, mapped, metadata and multicast mount destinations", async () => {
    for (const host of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "169.254.169.254", "224.0.0.1"])
      await expect(mountAddress(host)).rejects.toThrow();
    expect(await mountAddress("100.100.20.5")).toBe("100.100.20.5");
    expect(await mountAddress("fd00::42")).toBe("fd00::42");
  });
  it("keeps explicit simulation separate and enforces ownership and on-demand authorization", async () => {
    const network = new NetworkSharing({
      simulate: true,
      supported: false,
      secrets: new SecretBox(Buffer.alloc(32, 7)),
      apt: {} as AptManager,
      account: () => ({
        name: "fixture",
        uid: 1001,
        gid: 1001,
        home: "/home/fixture",
        shell: "/bin/sh",
      }),
      inspect: () => {
        throw new Error("Must not inspect the host in simulation");
      },
    });
    const input = mount();
    await network.apply(input, context);
    expect((await network.status(context.actor)).source).toBe("simulated");
    await expect(
      network.control(input.id, "connect", {
        ...context.actor,
        kind: "user",
        userId: randomUUID(),
        username: "other",
        role: "admin",
      }),
    ).rejects.toThrow("not found");
    await network.apply({ ...input, automount: false }, context);
    await expect(
      networkSharingHandlers(network)["sharing.mount.access"]({ id: input.id }, context),
    ).rejects.toThrow("SHARING_DISABLED");
    const policy = createPolicy({
      mode: "development",
      isProtected: () => false,
      servicesSource: "host",
      dockerSource: "host",
    });
    expect(policy("sharing.mount.apply", input, context.actor).allowed).toBe(false);
    expect(policy("sharing.status", {}, context.actor).allowed).toBe(true);
    expect(AGENT_OPERATIONS["sharing.mount.apply"].permission).toBe("system:manage");
    expect(AGENT_OPERATIONS["sharing.mount.access"].permission).toBe("files:read");
  });
});
