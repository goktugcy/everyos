import { describe, expect, it } from "vitest";
import { parseSmartctl, parseThrottled } from "./hardware.ts";
import { parseJournalLine, sanitizeLogText } from "./journal.ts";
import { parseCmdline, parsePasswd, parsePidStat, parsePidStatus } from "./proc-pid.ts";
import {
  compressIpv6,
  decodeMountField,
  looksLikeWholeDisk,
  parseDiskstats,
  parseIpv4Routes,
  parseIpv6Routes,
  parseLoadavg,
  parseMeminfo,
  parseMounts,
  parseNetDev,
  parseProcStat,
  parseResolvConf,
  parseUptime,
} from "./procfs.ts";
import { parseListUnitFiles, parseListUnits, parseShow, serviceDetailFromShow } from "./systemd.ts";
import { parseTailscaleStatus } from "./tailscale.ts";

const PROC_STAT = `cpu  10132153 290696 3084719 46828483 16683 0 25195 0 0 0
cpu0 2533038 72674 771179 11707120 4170 0 18799 0 0 0
cpu1 2533038 72674 771180 11707121 4171 0 2132 0 0 0
cpu2 2533038 72674 771180 11707121 4171 0 2132 0 0 0
cpu3 2533039 72674 771180 11707121 4171 0 2132 0 0 0
intr 1462898 0 0 0
ctxt 1990473
btime 1760000000
processes 2915
procs_running 1
procs_blocked 0
`;

const MEMINFO = `MemTotal:        8245852 kB
MemFree:         1203348 kB
MemAvailable:    6345120 kB
Buffers:          212344 kB
Cached:          4512320 kB
SwapCached:            0 kB
SReclaimable:     301234 kB
SwapTotal:       2097148 kB
SwapFree:        2097148 kB
HugePages_Total:       0
`;

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5231234   41234    0    0    0     0          0         0  5231234   41234    0    0    0     0       0          0
  eth0: 98123456789 87654321 2 0 0 0 0 1234 12345678901 23456789 1 0 0 0 0 0
tailscale0: 123456 789 0 0 0 0 0 0 654321 987 0 0 0 0 0 0
`;

const DISKSTATS = `   1       0 ram0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
   7       0 loop0 1104 0 9534 211 0 0 0 0 0 216 211 0 0 0 0 0 0
 259       0 nvme0n1 812345 12345 54321098 123456 456789 98765 87654321 234567 0 345678 358023 0 0 0 0 0 0
 259       1 nvme0n1p1 1234 0 98765 432 2 0 2 0 0 512 432 0 0 0 0 0 0
 259       2 nvme0n1p2 811000 12345 54222000 123000 456787 98765 87654319 234567 0 345000 357000 0 0 0 0 0 0
 179       0 mmcblk0 2345 0 123456 5678 0 0 0 0 0 4000 5678 0 0 0 0 0 0
`;

const MOUNTS = `/dev/nvme0n1p2 / ext4 rw,relatime 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
tmpfs /run tmpfs rw,nosuid,nodev,size=820488k,mode=755 0 0
/dev/nvme0n1p1 /boot/firmware vfat rw,relatime,fmask=0022 0 0
/dev/loop3 /snap/core22/1612 squashfs ro,nodev,relatime 0 0
overlay /var/lib/docker/overlay2/abc/merged overlay rw,relatime 0 0
//nas/Medya\\040Arsivi /mnt/medya\\040arsivi cifs rw,relatime 0 0
/dev/nvme0n1p2 /var/lib/docker ext4 rw,relatime 0 0
/dev/sda1 /mnt/backup ext4 ro,relatime 0 0
`;

describe("procfs parsers", () => {
  it("parses /proc/stat aggregate, per-core counters and boot time", () => {
    const parsed = parseProcStat(PROC_STAT)!;
    expect(parsed.total).toEqual({
      user: 10132153,
      nice: 290696,
      system: 3084719,
      idle: 46828483,
      iowait: 16683,
      irq: 0,
      softirq: 25195,
      steal: 0,
    });
    expect(parsed.cores).toHaveLength(4);
    expect(parsed.cores[3]!.user).toBe(2533039);
    expect(parsed.bootTime).toBe(1_760_000_000_000);
    expect(parseProcStat("garbage")).toBeNull();
  });

  it("parses /proc/meminfo in bytes and counts reclaimable slab as cache", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      totalBytes: 8245852 * 1024,
      availableBytes: 6345120 * 1024,
      freeBytes: 1203348 * 1024,
      buffersBytes: 212344 * 1024,
      cachedBytes: (4512320 + 301234) * 1024,
      swapTotalBytes: 2097148 * 1024,
      swapFreeBytes: 2097148 * 1024,
    });
    expect(parseMeminfo("MemTotal: 100 kB\n")).toBeNull();
  });

  it("parses load average and uptime", () => {
    expect(parseLoadavg("0.20 0.18 0.12 1/80 11206\n")).toEqual([0.2, 0.18, 0.12]);
    expect(parseLoadavg("x")).toBeNull();
    expect(parseUptime("350735.47 234388.90\n")).toBe(350735.47);
  });

  it("parses network counters per interface", () => {
    const net = parseNetDev(NET_DEV, (name) => name === "eth0");
    expect(net.map((i) => i.name)).toEqual(["lo", "eth0", "tailscale0"]);
    expect(net[1]).toEqual({
      name: "eth0",
      rxBytes: 98123456789,
      rxPackets: 87654321,
      rxErrors: 2,
      txBytes: 12345678901,
      txPackets: 23456789,
      txErrors: 1,
      physical: true,
    });
  });

  it("parses disk I/O for whole disks only", () => {
    const disks = parseDiskstats(DISKSTATS, looksLikeWholeDisk);
    expect(disks.map((d) => d.name)).toEqual(["nvme0n1", "mmcblk0"]);
    expect(disks[0]).toEqual({
      name: "nvme0n1",
      readOps: 812345,
      readBytes: 54321098 * 512,
      writeOps: 456789,
      writeBytes: 87654321 * 512,
      busyMs: 345678,
    });
    expect(looksLikeWholeDisk("sda")).toBe(true);
    expect(looksLikeWholeDisk("sda1")).toBe(false);
    expect(looksLikeWholeDisk("mmcblk0p2")).toBe(false);
    expect(looksLikeWholeDisk("zram0")).toBe(false);
  });

  it("keeps real filesystems, decodes escapes and skips duplicate devices", () => {
    const mounts = parseMounts(MOUNTS);
    expect(mounts.map((m) => m.mountpoint)).toEqual([
      "/",
      "/boot/firmware",
      "/mnt/medya arsivi",
      "/mnt/backup",
    ]);
    expect(mounts.find((m) => m.mountpoint === "/mnt/medya arsivi")!.device).toBe(
      "//nas/Medya Arsivi",
    );
    expect(mounts.find((m) => m.mountpoint === "/mnt/backup")!.readOnly).toBe(true);
    expect(decodeMountField("a\\011b")).toBe("a\tb");
  });

  it("finds default gateways and DNS servers", () => {
    const routes = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0
eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0
`;
    expect(parseIpv4Routes(routes)).toEqual([{ interface: "eth0", address: "192.168.1.1" }]);
    const v6 = `00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe80000000000000021122fffe334455 00000400 00000001 00000000 00000003     eth0
fe800000000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000001 00000000 00000001     eth0
`;
    expect(parseIpv6Routes(v6)).toEqual([
      { interface: "eth0", address: "fe80::211:22ff:fe33:4455" },
    ]);
    expect(compressIpv6(["2001", "0db8", "0000", "0000", "0000", "0000", "0000", "0001"])).toBe(
      "2001:db8::1",
    );
    expect(compressIpv6(["0000", "0000", "0000", "0000", "0000", "0000", "0000", "0001"])).toBe(
      "::1",
    );
    expect(
      parseResolvConf("# generated\nnameserver 192.168.1.1\nnameserver 1.1.1.1\nsearch lan\n"),
    ).toEqual(["192.168.1.1", "1.1.1.1"]);
  });
});

describe("hardware parsers", () => {
  it("decodes Raspberry Pi throttling flags", () => {
    const parsed = parseThrottled("throttled=0x50005\n")!;
    expect(parsed.raw).toBe("0x50005");
    expect(parsed.flags).toMatchObject({
      underVoltage: true,
      frequencyCapped: false,
      throttled: true,
      underVoltageOccurred: true,
      throttledOccurred: true,
      frequencyCappedOccurred: false,
    });
    expect(parseThrottled("0")!.flags.underVoltage).toBe(false);
    expect(parseThrottled("nope")).toBeNull();
  });

  it("summarises NVMe SMART data from smartctl JSON", () => {
    const json = {
      model_name: "Samsung SSD 980 1TB",
      smart_status: { passed: true },
      temperature: { current: 41 },
      nvme_smart_health_information_log: {
        critical_warning: 0,
        percentage_used: 3,
        available_spare: 100,
        power_on_hours: 4321,
        media_errors: 0,
      },
    };
    expect(parseSmartctl(json, "/dev/nvme0")).toEqual({
      device: "/dev/nvme0",
      model: "Samsung SSD 980 1TB",
      temperatureC: 41,
      percentageUsed: 3,
      availableSparePercent: 100,
      powerOnHours: 4321,
      mediaErrors: 0,
      criticalWarning: 0,
      healthy: true,
    });
    expect(parseSmartctl({ smartctl: {} }, "/dev/nvme0")).toBeNull();
  });
});

describe("systemd parsers", () => {
  it("parses list-units and list-unit-files JSON", () => {
    const units = parseListUnits([
      {
        unit: "ssh.service",
        load: "loaded",
        active: "active",
        sub: "running",
        description: "OpenBSD Secure Shell server",
      },
      {
        unit: "backup.service",
        load: "loaded",
        active: "failed",
        sub: "failed",
        description: "Backup",
      },
      { nonsense: true },
    ]);
    expect(units).toHaveLength(2);
    expect(units[1]).toMatchObject({ name: "backup.service", active: "failed" });
    const files = parseListUnitFiles([
      { unit_file: "ssh.service", state: "enabled", preset: "enabled" },
    ]);
    expect(files.get("ssh.service")).toBe("enabled");
    expect(parseListUnits("not an array")).toEqual([]);
  });

  it("maps systemctl show output to a service detail", () => {
    const props = parseShow(
      [
        "Id=nginx.service",
        "Description=A high performance web server",
        "LoadState=loaded",
        "ActiveState=active",
        "SubState=running",
        "UnitFileState=enabled",
        "MainPID=1234",
        "ActiveEnterTimestamp=@1760000000",
        "MemoryCurrent=12582912",
        "CPUUsageNSec=[not set]",
        "TasksCurrent=18446744073709551615",
        "NRestarts=2",
        "FragmentPath=/usr/lib/systemd/system/nginx.service",
        "Restart=on-failure",
        "Type=forking",
      ].join("\n"),
    );
    expect(serviceDetailFromShow(props, false)).toEqual({
      name: "nginx.service",
      description: "A high performance web server",
      load: "loaded",
      active: "active",
      sub: "running",
      unitFileState: "enabled",
      protected: false,
      mainPid: 1234,
      activeSince: 1_760_000_000_000,
      memoryBytes: 12582912,
      cpuNanoseconds: null,
      tasks: null,
      restarts: 2,
      fragmentPath: "/usr/lib/systemd/system/nginx.service",
      restartPolicy: "on-failure",
      type: "forking",
    });
  });
});

describe("journal parser", () => {
  it("parses JSON lines including byte-array messages", () => {
    const entry = parseJournalLine(
      JSON.stringify({
        __CURSOR: "s=abc;i=1",
        __REALTIME_TIMESTAMP: "1760000000123456",
        PRIORITY: "3",
        _SYSTEMD_UNIT: "backup.service",
        SYSLOG_IDENTIFIER: "rsync",
        _PID: "4321",
        _HOSTNAME: "pi5",
        MESSAGE: [72, 97, 116, 97, 58, 32, 195, 167, 196, 177, 107, 196, 177, 197, 159],
      }),
    );
    expect(entry).toEqual({
      cursor: "s=abc;i=1",
      ts: 1760000000123,
      priority: 3,
      unit: "backup.service",
      identifier: "rsync",
      pid: 4321,
      hostname: "pi5",
      message: "Hata: çıkış",
    });
  });

  it("drops unusable lines and strips control sequences", () => {
    expect(parseJournalLine("{not json")).toBeNull();
    expect(parseJournalLine(JSON.stringify({ MESSAGE: "x" }))).toBeNull();
    expect(sanitizeLogText("\u001b[31mred\u001b[0m\u0007 text\ttab")).toBe("red text\ttab");
    expect(sanitizeLogText("x".repeat(20_000))).toHaveLength(16_384);
  });
});

describe("tailscale parser", () => {
  it("extracts self, tailnet, exit node and peer counts", () => {
    const status = parseTailscaleStatus({
      Version: "1.88.1",
      BackendState: "Running",
      Self: {
        HostName: "pi5",
        DNSName: "pi5.tail1234.ts.net.",
        TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
        Online: true,
      },
      CurrentTailnet: { Name: "goktug@github", MagicDNSSuffix: "tail1234.ts.net" },
      ExitNodeStatus: null,
      Health: ["Some peers are advertising routes but --accept-routes is false"],
      Peer: {
        a: { HostName: "laptop", Online: true },
        b: { HostName: "phone", Online: false },
        c: { HostName: "exit", Online: true, ExitNode: true },
      },
    });
    expect(status).toEqual({
      status: { available: true },
      backendState: "Running",
      version: "1.88.1",
      hostName: "pi5",
      dnsName: "pi5.tail1234.ts.net",
      tailnet: "goktug@github",
      ips: ["100.101.102.103", "fd7a:115c:a1e0::1"],
      online: true,
      exitNode: { active: true, name: "exit", online: true },
      peers: { total: 3, online: 2 },
      health: ["Some peers are advertising routes but --accept-routes is false"],
    });
  });
});

describe("process parsers", () => {
  it("parses /proc/<pid>/stat with spaces and parentheses in the name", () => {
    const stat =
      "1234 (my (weird) proc) S 1 1234 1234 0 -1 4194560 1234 0 0 0 150 50 0 0 20 0 7 0 98765 123456789 2345 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 2 0 0 0 0 0";
    expect(parsePidStat(stat)).toEqual({
      pid: 1234,
      comm: "my (weird) proc",
      state: "S",
      cpuTicks: 200,
      threads: 7,
      startTicks: 98765,
    });
    expect(parsePidStat("garbage")).toBeNull();
  });

  it("reads uid and resident memory from status, and user names from passwd", () => {
    expect(parsePidStatus("Name:\tnginx\nUid:\t33\t33\t33\t33\nVmRSS:\t   12288 kB\n")).toEqual({
      uid: 33,
      rssBytes: 12288 * 1024,
    });
    expect(
      parsePasswd(
        "root:x:0:0:root:/root:/bin/bash\nwww-data:x:33:33::/var/www:/usr/sbin/nologin\n",
      ).get(33),
    ).toBe("www-data");
    expect(parseCmdline(Buffer.from("/usr/sbin/nginx\0-g\0daemon off;\0"))).toBe(
      "/usr/sbin/nginx -g daemon off;",
    );
  });
});
