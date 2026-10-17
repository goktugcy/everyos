import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  watch as watchPath,
  type FSWatcher,
} from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import {
  DISK_UUID_PATTERN,
  MOUNTABLE_FILESYSTEMS,
  type DiskDevice,
  type DiskList,
  type DiskRefusal,
  type DiskVolume,
} from "@everyos/shared";
import { CommandError, findExecutable, runCommand } from "../exec.ts";

export class DiskError extends Error {
  readonly kind: DiskRefusal | "unavailable";

  constructor(kind: DiskError["kind"], message: string) {
    super(message);
    this.name = "DiskError";
    this.kind = kind;
  }
}

/** The Linux account that owns files on filesystems without Unix permissions (FAT, exFAT, NTFS). */
export interface DiskOwner {
  uid: number;
  gid: number;
}

/** Disks of the host, and the volumes EveryOS may mount on them (docs/disks.md). */
export interface DiskManager {
  readonly source: "host" | "simulated";
  list(signal?: AbortSignal): Promise<DiskList>;
  /**
   * Mounts a volume under the mount root (or only changes whether it is remembered, that is
   * mounted at boot and whenever it is plugged in). Files on
   * FAT, exFAT and NTFS belong to `owner`; other users may read them.
   */
  mount(
    uuid: string,
    persistent: boolean,
    owner: DiskOwner | null,
    signal?: AbortSignal,
  ): Promise<DiskList>;
  /**
   * Unmounts an EveryOS-mounted volume and forgets it, so it can be unplugged; a remembered disk
   * that is not plugged in is only forgotten.
   */
  unmount(uuid: string, signal?: AbortSignal): Promise<DiskList>;
  /** Ticks when disks may have come or gone (first tick at once). */
  watch(signal: AbortSignal): AsyncIterable<{ at: number }>;
}

interface LsblkEntry {
  name?: unknown;
  type?: unknown;
  size?: unknown;
  model?: unknown;
  tran?: unknown;
  rm?: unknown;
  hotplug?: unknown;
  fstype?: unknown;
  label?: unknown;
  uuid?: unknown;
  mountpoints?: unknown;
  mountpoint?: unknown;
  ro?: unknown;
  children?: unknown;
}

const LSBLK_COLUMNS = "NAME,TYPE,SIZE,MODEL,TRAN,RM,HOTPLUG,FSTYPE,LABEL,UUID,MOUNTPOINTS,RO";
/** Devices that are never storage a person plugs in. */
const IGNORED = /^(?:loop|zram|ram|sr|fd|md\d+p)/;
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 128) : null;
const flag = (value: unknown) => value === true || value === "1" || value === 1;
const mounts = (entry: LsblkEntry): string[] =>
  (Array.isArray(entry.mountpoints) ? entry.mountpoints : [entry.mountpoint])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .slice(0, 16);

/** Mounts that make a disk part of the running system; such a disk is never touched. */
export function isSystemMount(path: string): boolean {
  return (
    path === "[SWAP]" ||
    ["/", "/usr", "/var", "/home", "/opt", "/etc", "/root", "/tmp", "/srv"].includes(path) ||
    /^\/(?:boot|usr|var)\//.test(path) ||
    path === "/boot"
  );
}

/** systemd's path escaping (`systemd-escape --path`), for the mount unit's name. */
export function escapeUnitPath(path: string): string {
  const trimmed = path.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
  if (!trimmed) return "-";
  return [...Buffer.from(trimmed)]
    .map((byte, index) => {
      const char = String.fromCharCode(byte);
      if (char === "/") return "-";
      if (/[A-Za-z0-9:_]/.test(char) || (char === "." && index > 0)) return char;
      return `\\x${byte.toString(16).padStart(2, "0")}`;
    })
    .join("");
}

/** The disk tree `lsblk --json` reports, as EveryOS shows it. */
export function parseLsblk(
  json: unknown,
  options: { mountRoot: string; persistent: ReadonlySet<string> },
): DiskDevice[] {
  const devices = (json as { blockdevices?: unknown } | null)?.blockdevices;
  if (!Array.isArray(devices)) return [];
  const root = `${options.mountRoot.replace(/\/$/, "")}/`;
  const descendants = (entry: LsblkEntry): LsblkEntry[] => [
    entry,
    ...(Array.isArray(entry.children) ? (entry.children as LsblkEntry[]).flatMap(descendants) : []),
  ];
  const volume = (entry: LsblkEntry): DiskVolume => {
    const fsType = text(entry.fstype);
    const uuid = text(entry.uuid);
    const points = mounts(entry);
    return {
      uuid: uuid && DISK_UUID_PATTERN.test(uuid) ? uuid : null,
      name: text(entry.name) ?? "?",
      sizeBytes: Math.max(0, Math.round(Number(entry.size) || 0)),
      fsType,
      label: text(entry.label),
      mountpoints: points,
      managed: points.some((point) => point.startsWith(root)),
      persistent: Boolean(uuid && options.persistent.has(uuid)),
      supported: MOUNTABLE_FILESYSTEMS.some((type) => type === fsType),
      readOnly: flag(entry.ro),
    };
  };
  return (devices as LsblkEntry[])
    .filter((entry) => entry.type === "disk" && !IGNORED.test(text(entry.name) ?? ""))
    .slice(0, 64)
    .map((entry): DiskDevice => {
      const children = Array.isArray(entry.children) ? (entry.children as LsblkEntry[]) : [];
      return {
        name: text(entry.name) ?? "?",
        model: text(entry.model),
        sizeBytes: Math.max(0, Math.round(Number(entry.size) || 0)),
        transport: text(entry.tran),
        removable: flag(entry.rm) || flag(entry.hotplug),
        // Any system mount anywhere below (partitions, LVM, encryption) protects the whole disk.
        system: descendants(entry).some((item) => mounts(item).some(isSystemMount)),
        volumes: (children.length
          ? children.filter((child) => child.type === "part")
          : text(entry.fstype)
            ? [entry]
            : []
        )
          .slice(0, 128)
          .map(volume),
      };
    });
}

const MARKER =
  "# Managed by EveryOS (Settings › Disks); removing the disk there deletes this file.";

/** A volume EveryOS mounted, as the mount table of the calling process shows it. */
export interface MountedDisk {
  uuid: string;
  path: string;
  label: string | null;
  readOnly: boolean;
}

/**
 * The volumes mounted under the mount root, read without privileges or commands (Files runs as
 * the person's Linux account): mount points from mountinfo, labels from udev's by-label links.
 */
export function readMountedDisks(options: {
  mountRoot: string;
  mountinfo?: string;
  devDir?: string;
}): MountedDisk[] {
  const root = `${options.mountRoot.replace(/\/$/, "")}/`;
  const devDir = options.devDir ?? "/dev/disk";
  let table: string;
  try {
    table = readFileSync(options.mountinfo ?? "/proc/self/mountinfo", "utf8");
  } catch {
    return [];
  }
  const unescape = (value: string) =>
    value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  const resolve = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  let labels: Map<string, string> | null = null;
  const label = (uuid: string) => {
    if (!labels) {
      labels = new Map();
      try {
        for (const name of readdirSync(`${devDir}/by-label`).slice(0, 256)) {
          const device = resolve(`${devDir}/by-label/${name}`);
          if (device)
            labels.set(
              device,
              name.replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) =>
                String.fromCharCode(parseInt(hex, 16)),
              ),
            );
        }
      } catch {
        // No udev links: the Files location is named by UUID.
      }
    }
    const device = resolve(`${devDir}/by-uuid/${uuid}`);
    return (device && labels.get(device)?.slice(0, 128)) || null;
  };
  const seen = new Map<string, MountedDisk>();
  for (const line of table.split("\n")) {
    const fields = line.split(" ");
    const path = fields[4] ? unescape(fields[4]) : "";
    if (!path.startsWith(root)) continue;
    const uuid = path.slice(root.length);
    if (!DISK_UUID_PATTERN.test(uuid)) continue;
    // The last mount on a path is the visible one.
    seen.set(uuid, {
      uuid,
      path,
      label: null,
      readOnly: (fields[5] ?? "").split(",").includes("ro"),
    });
  }
  return [...seen.values()].slice(0, 64).map((disk) => ({ ...disk, label: label(disk.uuid) }));
}

/**
 * Ticks whenever something below `dir` changes (udev adds and removes `/dev/disk/by-uuid` links
 * as disks come and go), debounced, plus follow-up ticks so mounts that systemd starts for a
 * plugged-in disk are seen, and a slow safety tick. Polls when the directory cannot be watched.
 */
export async function* watchDirectory(
  dir: string,
  signal: AbortSignal,
  options: { debounceMs?: number; followUpMs?: number[]; safetyMs?: number } = {},
): AsyncGenerator<{ at: number }> {
  const debounceMs = options.debounceMs ?? 700;
  const followUps = options.followUpMs ?? [2_000, 6_000];
  let dirty = false;
  // A real change (not a follow-up or safety tick) since the last tick.
  let changed = false;
  let wake: (() => void) | null = null;
  const notify = (real: boolean) => {
    dirty = true;
    if (real) changed = true;
    wake?.();
  };
  let watcher: FSWatcher | null = null;
  try {
    watcher = watchPath(dir, () => notify(true));
    watcher.on("error", () => undefined);
  } catch {
    // Not watchable (missing directory, no inotify): the safety tick polls instead.
  }
  const timers = new Set<NodeJS.Timeout>();
  const safety = setInterval(() => notify(false), options.safetyMs ?? (watcher ? 60_000 : 5_000));
  safety.unref?.();
  const aborted = () => wake?.();
  signal.addEventListener("abort", aborted);
  try {
    yield { at: Date.now() };
    while (!signal.aborted) {
      if (!dirty)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      wake = null;
      if (signal.aborted) break;
      await sleep(debounceMs, undefined, { signal }).catch(() => undefined);
      if (signal.aborted) break;
      const real = changed;
      dirty = changed = false;
      yield { at: Date.now() };
      // A disk systemd mounts on plug-in shows up as mounted a moment later.
      if (real)
        for (const ms of followUps) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            notify(false);
          }, ms);
          timer.unref?.();
          timers.add(timer);
        }
    }
  } finally {
    signal.removeEventListener("abort", aborted);
    watcher?.close();
    clearInterval(safety);
    for (const timer of timers) clearTimeout(timer);
  }
}

/** systemd's name for the device node of a filesystem UUID. */
function deviceUnit(uuid: string): string {
  return `${escapeUnitPath(`/dev/disk/by-uuid/${uuid}`)}.device`;
}

/** Remembered units mount at boot and whenever their disk is plugged in. */
function installSection(uuid: string): string {
  return `WantedBy=multi-user.target ${deviceUnit(uuid)}`;
}

function withInstallSection(content: string, uuid: string): string {
  return content.replace(/^WantedBy=.*$/m, installSection(uuid));
}

/**
 * The host's disks through `lsblk`, mounted by systemd itself: a mount unit per volume under the
 * mount root, in /run (once, until the next boot) or /etc (remembered: at every boot and whenever
 * the disk is plugged in). Mounting through PID 1 makes the mount visible to the whole host, not
 * only to the agent's own mount namespace.
 */
export function createDiskManager(options: {
  mountRoot: string;
  unitDir?: string;
  runtimeUnitDir?: string;
  /** Watched for disks coming and going. */
  devDir?: string;
}): DiskManager {
  const mountRoot = options.mountRoot.replace(/\/$/, "");
  const unitDir = options.unitDir ?? "/etc/systemd/system";
  const runtimeDir = options.runtimeUnitDir ?? "/run/systemd/system";
  const unit = (uuid: string) => `${escapeUnitPath(`${mountRoot}/${uuid}`)}.mount`;
  const tool = async (name: string) => {
    const path = await findExecutable(name);
    if (!path) throw new DiskError("unavailable", `${name} is not installed`);
    return path;
  };
  const systemctl = async (args: string[], signal?: AbortSignal) =>
    runCommand(await tool("systemctl"), ["--no-ask-password", ...args], {
      timeoutMs: 60_000,
      ...(signal ? { signal } : {}),
    });
  /** Remembered volumes: UUID → the unit's content. */
  const persistent = async () => {
    const prefix = escapeUnitPath(`${mountRoot}/`);
    const names = await readdir(unitDir).catch(() => [] as string[]);
    const units = new Map<string, string>();
    for (const name of names.slice(0, 256)) {
      if (!name.startsWith(`${prefix}-`) || !name.endsWith(".mount")) continue;
      const content = await readFile(join(unitDir, name), "utf8").catch(() => "");
      if (!content.startsWith(MARKER)) continue;
      const uuid = name
        .slice(prefix.length + 1, -".mount".length)
        .replace(/\\x([0-9a-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      if (DISK_UUID_PATTERN.test(uuid)) units.set(uuid, content);
    }
    return units;
  };
  // Units written before disks were remembered mounted only at boot.
  let upgraded: Promise<void> | null = null;
  const upgrade = (units: Map<string, string>) =>
    (upgraded ??= (async () => {
      const stale = [...units].filter(([uuid, content]) => !content.includes(deviceUnit(uuid)));
      if (!stale.length) return;
      for (const [uuid, content] of stale)
        await writeUnit(join(unitDir, unit(uuid)), withInstallSection(content, uuid));
      await systemctl(["daemon-reload"]);
      for (const [uuid] of stale) await systemctl(["enable", unit(uuid)]).catch(() => undefined);
    })().catch(() => undefined));
  const list = async (signal?: AbortSignal): Promise<DiskList> => {
    const output = await runCommand(
      await tool("lsblk"),
      ["--json", "--bytes", "--output", LSBLK_COLUMNS],
      { timeoutMs: 10_000, ...(signal ? { signal } : {}) },
    ).catch((error: unknown) => {
      throw error instanceof CommandError
        ? new DiskError("unavailable", "lsblk could not list the disks")
        : error;
    });
    const units = await persistent();
    void upgrade(units);
    const disks = parseLsblk(JSON.parse(output) as unknown, {
      mountRoot,
      persistent: new Set(units.keys()),
    });
    const present = new Set(disks.flatMap((disk) => disk.volumes.map((volume) => volume.uuid)));
    return {
      source: "host",
      mountRoot,
      disks,
      remembered: [...units]
        .filter(([uuid]) => !present.has(uuid))
        .slice(0, 64)
        .map(([uuid, content]) => {
          const label = /^Description=EveryOS disk (.+)$/m.exec(content)?.[1]?.trim().slice(0, 128);
          return { uuid, label: label && label !== uuid ? label : null };
        }),
    };
  };
  const find = (disks: DiskList, uuid: string) => {
    for (const disk of disks.disks)
      for (const volume of disk.volumes) if (volume.uuid === uuid) return { disk, volume };
    return null;
  };
  const writeUnit = async (path: string, content: string) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(`${path}.tmp`, content, { mode: 0o644 });
    await rename(`${path}.tmp`, path);
  };
  const forget = async (uuid: string, signal?: AbortSignal) => {
    const name = unit(uuid);
    await systemctl(["disable", name], signal).catch(() => undefined);
    await Promise.all([
      rm(join(unitDir, name), { force: true }),
      rm(join(runtimeDir, name), { force: true }),
    ]);
    await systemctl(["daemon-reload"], signal);
    await rmdir(`${mountRoot}/${uuid}`).catch(() => undefined);
  };
  return {
    source: "host",
    list,
    async mount(uuid, persist, owner, signal) {
      if (!DISK_UUID_PATTERN.test(uuid)) throw new DiskError("not-found", "Invalid volume UUID");
      const found = find(await list(signal), uuid);
      if (!found) throw new DiskError("not-found", "No volume with this UUID");
      const { disk, volume } = found;
      if (disk.system) throw new DiskError("system-disk", "The disk holds the running system");
      if (!volume.supported)
        throw new DiskError("unsupported-filesystem", "EveryOS does not mount this filesystem");
      if (volume.mountpoints.length && !volume.managed)
        throw new DiskError("mounted-elsewhere", "The volume is already mounted elsewhere");
      const where = `${mountRoot}/${uuid}`;
      const name = unit(uuid);
      // Changing only the remembered setting keeps the unit as it was (and its owner).
      const existing = (
        await Promise.all(
          [unitDir, runtimeDir].map((dir) => readFile(join(dir, name), "utf8").catch(() => "")),
        )
      ).find((content) => content.startsWith(MARKER));
      // Filesystems without Unix permissions belong to the administrator who mounts them, as a
      // desktop's automounter would do; everyone else may read.
      const foreign =
        volume.fsType === "vfat" || volume.fsType === "exfat" || volume.fsType === "ntfs";
      const mountOptions = [
        "nodev",
        "nosuid",
        "noexec",
        "noatime",
        "nofail",
        ...(foreign && owner ? [`uid=${owner.uid}`, `gid=${owner.gid}`] : []),
        ...(foreign ? ["umask=0022"] : []),
      ].join(",");
      const content = withInstallSection(
        existing ??
          [
            MARKER,
            "[Unit]",
            `Description=EveryOS disk ${volume.label ?? uuid}`.replace(/[\r\n]/g, " "),
            "",
            "[Mount]",
            `What=/dev/disk/by-uuid/${uuid}`,
            `Where=${where}`,
            `Type=${volume.fsType === "ntfs" ? "ntfs3" : volume.fsType}`,
            `Options=${mountOptions}`,
            "TimeoutSec=60",
            "",
            "[Install]",
            installSection(uuid),
            "",
          ].join("\n"),
        uuid,
      );
      await mkdir(where, { recursive: true, mode: 0o755 });
      // /run units last until the next boot; /etc units are remembered.
      await writeUnit(join(persist ? unitDir : runtimeDir, name), content);
      await rm(join(persist ? runtimeDir : unitDir, name), { force: true });
      await systemctl(["daemon-reload"], signal);
      await systemctl([persist ? "enable" : "disable", name], signal).catch(() => undefined);
      if (!volume.managed)
        try {
          await systemctl(["start", name], signal);
        } catch {
          await Promise.all([
            rm(join(unitDir, name), { force: true }),
            rm(join(runtimeDir, name), { force: true }),
          ]);
          await systemctl(["daemon-reload"], signal).catch(() => undefined);
          await rmdir(where).catch(() => undefined);
          throw new DiskError("mount-failed", "The volume could not be mounted");
        }
      return list(signal);
    },
    async unmount(uuid, signal) {
      if (!DISK_UUID_PATTERN.test(uuid)) throw new DiskError("not-found", "Invalid volume UUID");
      const listing = await list(signal);
      const found = find(listing, uuid);
      if (!found) {
        // A remembered disk that is not plugged in is only forgotten.
        if (!listing.remembered.some((disk) => disk.uuid === uuid))
          throw new DiskError("not-found", "No volume with this UUID");
        await forget(uuid, signal);
        return list(signal);
      }
      const { disk, volume } = found;
      if (disk.system) throw new DiskError("system-disk", "The disk holds the running system");
      if (!volume.managed && !volume.persistent)
        throw new DiskError("not-found", "EveryOS did not mount this volume");
      if (volume.managed)
        try {
          await systemctl(["stop", unit(uuid)], signal);
        } catch {
          throw new DiskError("busy", "The volume is in use");
        }
      await forget(uuid, signal);
      return list(signal);
    },
    watch: (signal) => watchDirectory(options.devDir ?? "/dev/disk/by-uuid", signal),
  };
}

const SIMULATED_STICK = "5E6F-7A8B";
/** In development, this file below the mount root stands for a plugged-in USB stick. */
export const SIMULATED_STICK_MARKER = ".simulated-usb-stick";

/**
 * Development stand-in: a system card and a USB disk with two volumes, plus a USB stick that is
 * plugged in while `<mount root>/.simulated-usb-stick` exists. Nothing on the host changes.
 */
export function createDiskSimulator(options: { mountRoot: string }): DiskManager {
  const mountRoot = options.mountRoot.replace(/\/$/, "");
  const state = new Map<string, { mounted: boolean; persistent: boolean }>([
    ["2f6a3c1e-8b4d-4e7a-9f10-3b5c7d9e1a24", { mounted: false, persistent: false }],
    ["A1B2-C3D4", { mounted: false, persistent: false }],
    [SIMULATED_STICK, { mounted: false, persistent: false }],
  ]);
  let stickPresent = false;
  const plugged = () => {
    const present = existsSync(join(mountRoot, SIMULATED_STICK_MARKER));
    const stick = state.get(SIMULATED_STICK)!;
    if (present !== stickPresent) {
      stickPresent = present;
      // Unplugging drops the mount; a remembered stick mounts again when plugged in.
      stick.mounted = present && stick.persistent;
      if (stick.mounted) mkdirSync(join(mountRoot, SIMULATED_STICK), { recursive: true });
    }
    return present;
  };
  const list = (): Promise<DiskList> => {
    const volume = (
      uuid: string,
      name: string,
      fsType: string,
      label: string,
      sizeBytes: number,
    ): DiskVolume => {
      const entry = state.get(uuid)!;
      return {
        uuid,
        name,
        sizeBytes,
        fsType,
        label,
        mountpoints: entry.mounted ? [`${mountRoot}/${uuid}`] : [],
        managed: entry.mounted,
        persistent: entry.persistent,
        supported: true,
        readOnly: false,
      };
    };
    const stick = plugged();
    return Promise.resolve({
      source: "simulated",
      mountRoot,
      disks: [
        {
          name: "mmcblk0",
          model: null,
          sizeBytes: 63_864_569_856,
          transport: "mmc",
          removable: false,
          system: true,
          volumes: [
            {
              uuid: "B3D1-5A2F",
              name: "mmcblk0p1",
              sizeBytes: 536_870_912,
              fsType: "vfat",
              label: "system-boot",
              mountpoints: ["/boot/firmware"],
              managed: false,
              persistent: false,
              supported: true,
              readOnly: false,
            },
            {
              uuid: "9c2e7f41-63a8-4b0e-8d5c-1f7a2b3c4d5e",
              name: "mmcblk0p2",
              sizeBytes: 63_327_698_944,
              fsType: "ext4",
              label: "writable",
              mountpoints: ["/"],
              managed: false,
              persistent: false,
              supported: true,
              readOnly: false,
            },
          ],
        },
        {
          name: "sda",
          model: "Simulated USB Disk",
          sizeBytes: 1_000_204_886_016,
          transport: "usb",
          removable: true,
          system: false,
          volumes: [
            volume(
              "2f6a3c1e-8b4d-4e7a-9f10-3b5c7d9e1a24",
              "sda1",
              "ext4",
              "Yedek",
              900_000_000_000,
            ),
            volume("A1B2-C3D4", "sda2", "exfat", "PHOTOS", 100_204_886_016),
          ],
        },
        ...(stick
          ? [
              {
                name: "sdb",
                model: "Simulated USB Stick",
                sizeBytes: 32_015_679_488,
                transport: "usb",
                removable: true,
                system: false,
                volumes: [volume(SIMULATED_STICK, "sdb1", "exfat", "KINGSTON", 32_014_630_912)],
              },
            ]
          : []),
      ],
      remembered:
        !stick && state.get(SIMULATED_STICK)!.persistent
          ? [{ uuid: SIMULATED_STICK, label: "KINGSTON" }]
          : [],
    });
  };
  const known = (uuid: string) => {
    const entry = state.get(uuid);
    if (!entry || (uuid === SIMULATED_STICK && !plugged() && !entry.persistent))
      throw new DiskError("not-found", "No volume with this UUID");
    return entry;
  };
  return {
    source: "simulated",
    list,
    async mount(uuid, persistent) {
      if (uuid === "B3D1-5A2F" || uuid === "9c2e7f41-63a8-4b0e-8d5c-1f7a2b3c4d5e")
        throw new DiskError("system-disk", "The disk holds the running system");
      const entry = known(uuid);
      if (uuid === SIMULATED_STICK && !plugged())
        throw new DiskError("not-found", "No volume with this UUID");
      // A real directory, so the development Files app can browse the simulated disk.
      await mkdir(join(mountRoot, uuid), { recursive: true });
      entry.mounted = true;
      entry.persistent = persistent;
      return list();
    },
    async unmount(uuid) {
      const entry = known(uuid);
      entry.mounted = false;
      entry.persistent = false;
      return list();
    },
    watch: (signal) => {
      mkdirSync(mountRoot, { recursive: true });
      return watchDirectory(mountRoot, signal, { followUpMs: [], safetyMs: 5_000 });
    },
  };
}
