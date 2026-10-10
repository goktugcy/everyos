import type {
  LogEntry,
  LogPage,
  LogQuery,
  ServiceAction,
  ServiceDetail,
  ServiceUnit,
  TimerSummary,
} from "@otuken/shared";
import type { LogFilter, LogSource } from "../logs/journal-client.ts";
import { ServiceError, type ServiceManager } from "../services/systemd-client.ts";

/*
 * Development-only stand-ins for systemd and journald, used when the agent
 * runs in development mode on a host without them (e.g. macOS). Every
 * response is marked `source: "simulated"` and the UI labels it as such.
 * Nothing here touches the host.
 */

interface SimUnit {
  name: string;
  description: string;
  active: "active" | "inactive" | "failed";
  sub: string;
  enabled: "enabled" | "disabled" | "static";
  memoryBytes: number;
}

const INITIAL_UNITS: SimUnit[] = [
  {
    name: "ssh.service",
    description: "OpenBSD Secure Shell server",
    active: "active",
    sub: "running",
    enabled: "enabled",
    memoryBytes: 6_291_456,
  },
  {
    name: "cron.service",
    description: "Regular background program processing daemon",
    active: "active",
    sub: "running",
    enabled: "enabled",
    memoryBytes: 1_048_576,
  },
  {
    name: "docker.service",
    description: "Docker Application Container Engine",
    active: "active",
    sub: "running",
    enabled: "enabled",
    memoryBytes: 92_274_688,
  },
  {
    name: "tailscaled.service",
    description: "Tailscale node agent",
    active: "active",
    sub: "running",
    enabled: "enabled",
    memoryBytes: 41_943_040,
  },
  {
    name: "nginx.service",
    description: "A high performance web server and a reverse proxy server",
    active: "active",
    sub: "running",
    enabled: "enabled",
    memoryBytes: 12_582_912,
  },
  {
    name: "jellyfin.service",
    description: "Jellyfin Media Server",
    active: "inactive",
    sub: "dead",
    enabled: "disabled",
    memoryBytes: 0,
  },
  {
    name: "backup-sync.service",
    description: "Nightly backup synchronisation",
    active: "failed",
    sub: "failed",
    enabled: "enabled",
    memoryBytes: 0,
  },
  {
    name: "systemd-journald.service",
    description: "Journal Service",
    active: "active",
    sub: "running",
    enabled: "static",
    memoryBytes: 18_874_368,
  },
  {
    name: "otuken.service",
    description: "Otuken API",
    active: "active",
    sub: "running",
    enabled: "enabled",
    memoryBytes: 78_643_200,
  },
  {
    name: "otuken-agent.service",
    description: "Otuken privileged agent",
    active: "active",
    sub: "running",
    enabled: "enabled",
    memoryBytes: 64_487_424,
  },
  {
    name: "unattended-upgrades.service",
    description: "Unattended Upgrades Shutdown",
    active: "active",
    sub: "running",
    enabled: "enabled",
    memoryBytes: 22_020_096,
  },
  {
    name: "smartd.service",
    description: "Self Monitoring and Reporting Technology (SMART) Daemon",
    active: "active",
    sub: "running",
    enabled: "enabled",
    memoryBytes: 3_145_728,
  },
];

const MESSAGES: Array<[string, number, string]> = [
  ["ssh.service", 6, "Accepted publickey for admin from 100.101.102.103 port 51234 ssh2"],
  [
    "cron.service",
    6,
    "(root) CMD (test -x /usr/sbin/anacron || run-parts --report /etc/cron.daily)",
  ],
  ["docker.service", 6, "Container healthcheck passed for jellyfin"],
  ["nginx.service", 4, "upstream response is buffered to a temporary file"],
  ["backup-sync.service", 3, "rsync: connection unexpectedly closed (0 bytes received so far)"],
  ["tailscaled.service", 6, "magicsock: endpoints changed: 192.168.1.20:41641 (local)"],
  ["smartd.service", 6, "Device: /dev/nvme0, SMART Health Status: OK"],
];

export interface Simulator {
  services: ServiceManager;
  logs: LogSource;
}

export function createSimulator(now: () => number = Date.now): Simulator {
  const units = new Map(INITIAL_UNITS.map((unit) => [unit.name, { ...unit }]));
  const entries: LogEntry[] = [];
  const listeners = new Set<(entry: LogEntry) => void>();
  let sequence = 0;

  const log = (unit: string | null, priority: number, message: string, ts = now()) => {
    const entry: LogEntry = {
      cursor: `sim;${(sequence++).toString(36)}`,
      ts,
      priority,
      unit,
      identifier: unit?.replace(/\.service$/, "") ?? "kernel",
      pid: unit ? 1000 + (sequence % 900) : null,
      hostname: "otuken-dev",
      message,
    };
    entries.push(entry);
    if (entries.length > 5_000) entries.shift();
    for (const listener of listeners) listener(entry);
    return entry;
  };

  // Seed a little history (last 30 minutes).
  const start = now() - 30 * 60_000;
  for (let i = 0; i < 300; i++) {
    const [unit, priority, message] = MESSAGES[i % MESSAGES.length]!;
    log(unit, priority, message, start + i * 6_000);
  }

  const toUnit = (unit: SimUnit, isProtected: (name: string) => boolean): ServiceUnit => ({
    name: unit.name,
    description: unit.description,
    load: "loaded",
    active: unit.active,
    sub: unit.sub,
    unitFileState: unit.enabled,
    protected: isProtected(unit.name),
  });

  const matches = (entry: LogEntry, filter: LogFilter) =>
    (!filter.unit || entry.unit === filter.unit) &&
    (filter.priority === undefined || entry.priority <= filter.priority) &&
    (filter.since === undefined || entry.ts >= filter.since) &&
    (filter.until === undefined || entry.ts <= filter.until) &&
    (!filter.grep || entry.message.toLowerCase().includes(filter.grep.toLowerCase()));

  const services: ServiceManager = {
    source: "simulated",
    list(isProtected) {
      return Promise.resolve({
        source: "simulated",
        units: [...units.values()].map((u) => toUnit(u, isProtected)),
      });
    },
    get(name, isProtected) {
      const unit = units.get(name);
      if (!unit) return Promise.reject(new ServiceError("not-found", `Unit ${name} not found`));
      const detail: ServiceDetail = {
        ...toUnit(unit, isProtected),
        source: "simulated",
        mainPid: unit.active === "active" ? 1000 + name.length : null,
        activeSince: unit.active === "active" ? now() - 3 * 3_600_000 : null,
        memoryBytes: unit.active === "active" ? unit.memoryBytes : null,
        cpuNanoseconds: unit.active === "active" ? 12_500_000_000 : null,
        tasks: unit.active === "active" ? 4 : null,
        restarts: 0,
        fragmentPath: `/usr/lib/systemd/system/${name}`,
        restartPolicy: "on-failure",
        type: "simple",
      };
      return Promise.resolve(detail);
    },
    control(name, action: ServiceAction) {
      const unit = units.get(name);
      if (!unit) return Promise.reject(new ServiceError("not-found", `Unit ${name} not found`));
      if (action === "start" || action === "restart" || action === "reload") {
        unit.active = "active";
        unit.sub = "running";
        unit.memoryBytes ||= 8_388_608;
      } else if (action === "stop") {
        unit.active = "inactive";
        unit.sub = "dead";
      } else if (action === "enable") unit.enabled = "enabled";
      else unit.enabled = "disabled";
      log(name, 6, `Simulated ${action} of ${name}`);
      return Promise.resolve();
    },
    timers: () => Promise.resolve(timers()),
  };

  const timers = (): TimerSummary => ({
    source: "simulated",
    timers: [
      {
        unit: "apt-daily.timer",
        activates: "apt-daily.service",
        next: now() + 5 * 3_600_000,
        last: now() - 19 * 3_600_000,
      },
      {
        unit: "backup-sync.timer",
        activates: "backup-sync.service",
        next: now() + 9 * 3_600_000,
        last: now() - 15 * 3_600_000,
      },
      {
        unit: "fstrim.timer",
        activates: "fstrim.service",
        next: now() + 3 * 86_400_000,
        last: now() - 4 * 86_400_000,
      },
      {
        unit: "logrotate.timer",
        activates: "logrotate.service",
        next: now() + 2 * 3_600_000,
        last: now() - 22 * 3_600_000,
      },
    ],
  });

  const logs: LogSource = {
    source: "simulated",
    query(query: LogQuery): Promise<LogPage> {
      let candidates = entries.filter((entry) => matches(entry, query)).reverse();
      if (query.before) {
        const index = candidates.findIndex((entry) => entry.cursor === query.before);
        candidates = index >= 0 ? candidates.slice(index + 1) : [];
      }
      return Promise.resolve({
        source: "simulated",
        entries: candidates.slice(0, query.limit),
        hasMore: candidates.length > query.limit,
      });
    },
    async *follow(filter, signal) {
      const queue: LogEntry[] = [];
      let wake: (() => void) | null = null;
      const listener = (entry: LogEntry) => {
        if (matches(entry, filter)) {
          queue.push(entry);
          wake?.();
        }
      };
      listeners.add(listener);
      const ticker = setInterval(() => {
        const [unit, priority, message] = MESSAGES[sequence % MESSAGES.length]!;
        log(unit, priority, message);
      }, 3_000);
      try {
        while (!signal.aborted) {
          while (queue.length > 0) yield queue.shift()!;
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          wake = null;
        }
      } finally {
        clearInterval(ticker);
        listeners.delete(listener);
      }
    },
  };

  return { services, logs };
}
