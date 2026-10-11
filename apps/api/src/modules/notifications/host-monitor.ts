import type { Actor } from "@everyos/agent-protocol";
import type { Logger } from "@everyos/logger";
import type { NotificationKind } from "@everyos/shared";
import type { AgentGateway } from "../../services.ts";
import { collectAlerts, type AlertSources, type TaggedAlert } from "../widgets/providers.ts";
import type { NotificationService } from "./notification-service.ts";
import { analyzeTailscale } from "../system/tailscale.ts";

/** What the Tailscale checks need to know about this EveryOS. */
export interface TailscaleContext {
  server: { port: number; publicOrigins: readonly string[] };
  isTrustedProxy: (address: string) => boolean;
  now: () => number;
}

const ACTOR: Actor = { kind: "system", component: "notifications" };

/** Alert kinds (widgets) → notification kinds, with the source that must have answered. */
const ALERT_KINDS: Record<
  TaggedAlert["kind"],
  { kind: NotificationKind; source: keyof AlertSources }
> = {
  "service-failed": { kind: "service-failed", source: "services" },
  "disk-full": { kind: "storage-low", source: "storage" },
  "container-unhealthy": { kind: "container-unhealthy", source: "docker" },
  "under-voltage": { kind: "under-voltage", source: "hardware" },
  throttling: { kind: "throttling", source: "hardware" },
  "nvme-unhealthy": { kind: "nvme-unhealthy", source: "hardware" },
  "security-updates": { kind: "security-updates", source: "apt" },
};

/** Problems must persist across two checks before users are alerted. */
const CONFIRMATIONS = 2;

/**
 * Watches the host in the background and turns problems into notification
 * conditions: raised when they appear, resolved when they clear. One check
 * every two minutes reuses the agent's cached collectors, so it costs a few
 * hundred milliseconds of agent time per check.
 */
export class HostMonitor {
  readonly #agent: AgentGateway;
  readonly #notifications: NotificationService;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | null = null;
  #controller = new AbortController();
  #running: Promise<void> | null = null;
  #agentDown = 0;
  #offline = 0;

  readonly #tailscale: TailscaleContext | null;

  constructor(deps: {
    agent: AgentGateway;
    notifications: NotificationService;
    logger: Logger;
    intervalMs?: number;
    /** Enables the Tailscale key-expiry and Funnel checks. */
    tailscale?: TailscaleContext;
  }) {
    this.#tailscale = deps.tailscale ?? null;
    this.#agent = deps.agent;
    this.#notifications = deps.notifications;
    this.#logger = deps.logger.child({ component: "host-monitor" });
    this.#intervalMs = deps.intervalMs ?? 120_000;
  }

  start(firstDelayMs = 20_000): void {
    if (this.#timer) return;
    const loop = (delay: number) => {
      this.#timer = setTimeout(() => {
        void this.check().finally(() => {
          if (!this.#controller.signal.aborted) loop(this.#intervalMs);
        });
      }, delay);
      this.#timer.unref();
    };
    loop(firstDelayMs);
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#controller.abort();
  }

  /** One check (concurrent calls share it). Never throws. */
  check(): Promise<void> {
    this.#running ??= this.#check()
      .catch((error: unknown) => this.#logger.warn("Host check failed", { error }))
      .finally(() => {
        this.#running = null;
      });
    return this.#running;
  }

  async #check(): Promise<void> {
    if (this.#agent.state !== "connected") {
      if (++this.#agentDown >= CONFIRMATIONS)
        this.#notifications.raise({ kind: "agent-unavailable", severity: "critical" });
      return;
    }
    this.#agentDown = 0;
    this.#notifications.resolve("agent-unavailable");

    const signal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(60_000)]);
    const { alerts, sources } = await collectAlerts(this.#agent, signal);
    const active = new Set<string>();
    for (const alert of alerts) {
      const mapping = ALERT_KINDS[alert.kind];
      this.#notifications.raise({
        kind: mapping.kind,
        severity: alert.severity,
        key: alert.key,
        params: alert.params,
      });
      active.add(`${mapping.kind}:${alert.key}`);
    }
    // Only sources that answered may clear their problems.
    const checked = [
      ...new Set(
        Object.values(ALERT_KINDS)
          .filter((m) => sources[m.source])
          .map((m) => m.kind),
      ),
    ];
    this.#notifications.resolveMissing(checked, active);

    await this.#checkNetwork(signal);
  }

  async #checkNetwork(signal: AbortSignal): Promise<void> {
    const network = await this.#agent
      .call("network.status", {}, ACTOR, { signal })
      .catch(() => null);
    const internet = network?.internet.state;
    if (internet === "offline") {
      if (++this.#offline >= CONFIRMATIONS)
        this.#notifications.raise({ kind: "internet-offline", severity: "warning" });
    } else if (internet === "online") {
      this.#offline = 0;
      this.#notifications.resolve("internet-offline");
    }
    const tailscale = await this.#agent
      .call("tailscale.status", {}, ACTOR, { signal })
      .catch(() => null);
    if (!tailscale) return;
    if (tailscale.status.available && tailscale.online === false)
      this.#notifications.raise({
        kind: "tailscale-offline",
        severity: "warning",
        params: { state: tailscale.backendState ?? "unknown" },
      });
    else this.#notifications.resolve("tailscale-offline");

    if (!this.#tailscale) return;
    const details = await this.#agent
      .call("tailscale.details", {}, ACTOR, { signal })
      .catch(() => null);
    if (!details) return;
    const { warnings } = analyzeTailscale({
      status: tailscale,
      details,
      server: this.#tailscale.server,
      isTrustedProxy: this.#tailscale.isTrustedProxy,
      now: this.#tailscale.now(),
    });
    const key = warnings.find((w) => w.kind === "key-expired" || w.kind === "key-expiring");
    if (key)
      this.#notifications.raise({
        kind: "tailscale-key-expiry",
        severity: key.severity === "critical" ? "critical" : "warning",
        params: key.kind === "key-expired" ? { days: 0 } : { days: key.params.days ?? 0 },
      });
    else this.#notifications.resolve("tailscale-key-expiry");
    const funnel = warnings.find((w) => w.kind === "funnel-public");
    if (funnel)
      this.#notifications.raise({
        kind: "tailscale-funnel",
        severity: "critical",
        params: { url: funnel.params.url ?? "" },
      });
    else this.#notifications.resolve("tailscale-funnel");
  }
}
