import type { Actor } from "@everyos/agent-protocol";
import type { Logger } from "@everyos/logger";
import { DISK_REFUSALS, diskRootId, type DiskList, type DiskVolume } from "@everyos/shared";
import { ApiError } from "../../http/errors.ts";
import { toApiError } from "../../http/agent.ts";
import type { AgentGateway } from "../../services.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { FileRootConfig } from "../files/file-service.ts";
import type { NotificationService } from "../notifications/notification-service.ts";

const SYSTEM: Actor = { kind: "system", component: "disks" };
const REFRESH_MS = 30_000;

type DiskListener = (list: DiskList) => void;

/** Non-system volumes EveryOS could show, by UUID. */
function volumesOf(list: DiskList): Map<string, { volume: DiskVolume; model: string | null }> {
  const volumes = new Map<string, { volume: DiskVolume; model: string | null }>();
  for (const disk of list.disks)
    if (!disk.system)
      for (const volume of disk.volumes)
        if (volume.uuid && volume.supported)
          volumes.set(volume.uuid, { volume, model: disk.model });
  return volumes;
}

/**
 * Disks through the agent (docs/disks.md). It follows the agent's disk watcher, tells live
 * subscribers about every change and announces plugged-in disks. The last listing also feeds
 * Files, which offers every disk EveryOS mounted as a location.
 */
export class DiskService {
  readonly #agent: AgentGateway;
  readonly #audit: AuditLog;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #notifications: NotificationService | null;
  readonly #listeners = new Set<DiskListener>();
  #last: { at: number; list: DiskList } | null = null;
  #refreshing: Promise<unknown> | null = null;
  #following: AbortController | null = null;
  /** Volumes present at the last watched listing; null until the first one (no announcements). */
  #seen: Map<string, { volume: DiskVolume; model: string | null }> | null = null;
  #published = "";

  constructor(deps: {
    agent: AgentGateway;
    audit: AuditLog;
    logger: Logger;
    now: () => number;
    notifications?: NotificationService;
  }) {
    this.#agent = deps.agent;
    this.#audit = deps.audit;
    this.#logger = deps.logger.child({ component: "disks" });
    this.#now = deps.now;
    this.#notifications = deps.notifications ?? null;
  }

  /** Follows the agent's disk watcher, reconnecting with backoff. */
  start(): void {
    if (this.#following) return;
    const controller = new AbortController();
    this.#following = controller;
    void (async () => {
      let delay = 1_000;
      while (!controller.signal.aborted) {
        if (this.#agent.state === "connected") {
          try {
            for await (const _tick of this.#agent.stream("disks.watch", {}, SYSTEM, {
              signal: controller.signal,
            })) {
              delay = 1_000;
              await this.list(SYSTEM, controller.signal).catch((error: unknown) =>
                this.#logger.debug("Disk listing failed", { error }),
              );
            }
          } catch (error) {
            if (!controller.signal.aborted) this.#logger.debug("Disk watcher ended", { error });
          }
        }
        if (controller.signal.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, delay).unref());
        delay = Math.min(delay * 2, 30_000);
      }
    })();
  }

  stop(): void {
    this.#following?.abort();
    this.#following = null;
  }

  /** Every changed listing; the latest one is replayed at once. */
  subscribe(listener: DiskListener): () => void {
    this.#listeners.add(listener);
    if (this.#last) listener(this.#last.list);
    else void this.list(SYSTEM).catch(() => undefined);
    return () => this.#listeners.delete(listener);
  }

  async list(actor: Actor, signal?: AbortSignal): Promise<DiskList> {
    return this.#keep(
      await this.#agent
        .call("disks.list", {}, actor, signal ? { signal } : {})
        .catch((error: unknown) => {
          throw refusal(error);
        }),
    );
  }

  async mount(uuid: string, persistent: boolean, actor: Actor): Promise<DiskList> {
    try {
      const list = this.#keep(await this.#agent.call("disks.mount", { uuid, persistent }, actor));
      this.#event("mount", actor, uuid, "success", { persistent });
      return list;
    } catch (error) {
      const failure = refusal(error);
      this.#event("mount", actor, uuid, "failure", { reason: reasonOf(failure) });
      throw failure;
    }
  }

  async unmount(uuid: string, actor: Actor): Promise<DiskList> {
    try {
      const list = this.#keep(await this.#agent.call("disks.unmount", { uuid }, actor));
      this.#event("unmount", actor, uuid, "success");
      return list;
    } catch (error) {
      const failure = refusal(error);
      this.#event("unmount", actor, uuid, "failure", { reason: reasonOf(failure) });
      throw failure;
    }
  }

  /** A volume by filesystem UUID, from a fresh listing when the last one is old. */
  async volume(uuid: string): Promise<DiskVolume | null> {
    const list =
      this.#last && this.#now() - this.#last.at <= REFRESH_MS
        ? this.#last.list
        : await this.list(SYSTEM).catch(() => this.#last?.list ?? null);
    for (const disk of list?.disks ?? [])
      for (const volume of disk.volumes) if (volume.uuid === uuid) return volume;
    return null;
  }

  /** Mounted EveryOS disks as Files locations, from the last listing (refreshed in passing). */
  fileRoots(): FileRootConfig[] {
    if ((!this.#last || this.#now() - this.#last.at > REFRESH_MS) && !this.#refreshing)
      this.#refreshing = this.list(SYSTEM)
        .catch((error: unknown) => this.#logger.debug("Disk listing failed", { error }))
        .finally(() => {
          this.#refreshing = null;
        });
    return (this.#last?.list.disks ?? []).flatMap((disk) =>
      disk.system
        ? []
        : disk.volumes.flatMap((volume) =>
            volume.uuid && volume.managed
              ? [
                  {
                    id: diskRootId(volume.uuid),
                    name: volume.label ?? disk.model ?? volume.name,
                    path: `${this.#last!.list.mountRoot}/${volume.uuid}`,
                    readOnly: volume.readOnly,
                    kind: "disk" as const,
                  },
                ]
              : [],
          ),
    );
  }

  #keep(list: DiskList): DiskList {
    this.#last = { at: this.#now(), list };
    this.#announce(list);
    const serialized = JSON.stringify(list);
    if (serialized !== this.#published) {
      this.#published = serialized;
      for (const listener of this.#listeners) listener(list);
    }
    return list;
  }

  /** Announces plugged-in disks, and mounted disks pulled out without being removed. */
  #announce(list: DiskList): void {
    const current = volumesOf(list);
    const previous = this.#seen;
    this.#seen = current;
    if (!previous || !this.#notifications) return;
    for (const [uuid, { volume, model }] of current)
      if (!previous.has(uuid))
        this.#notifications.publish({
          kind: "disk-attached",
          severity: "info",
          key: uuid,
          params: {
            disk: volume.label ?? model ?? volume.name,
            uuid,
            // systemd mounts a remembered disk a moment after it appears.
            mounted: volume.managed || volume.persistent ? "yes" : "no",
          },
        });
    for (const [uuid, { volume, model }] of previous)
      if (!current.has(uuid))
        this.#notifications.publish({
          kind: "disk-detached",
          // Still mounted when it went: cached writes may be lost.
          severity: volume.managed ? "warning" : "info",
          key: uuid,
          params: {
            disk: volume.label ?? model ?? volume.name,
            uuid,
            unsafe: volume.managed ? "yes" : "no",
          },
        });
  }

  #event(
    action: string,
    actor: Actor,
    uuid: string,
    outcome: "success" | "failure",
    details: Record<string, string | boolean> = {},
  ): void {
    this.#audit.record({
      action: `disks.${action}`,
      target: uuid,
      outcome,
      ...(actor.kind === "user"
        ? { actor: { userId: actor.userId, username: actor.username }, ip: actor.ip ?? null }
        : {}),
      details,
    });
  }
}

/** Agent refusals arrive as "<reason>: …"; the reason becomes part of the API error. */
function refusal(error: unknown): ApiError {
  const failure = toApiError(error);
  if (failure.code !== "CONFLICT") return failure;
  const reason = DISK_REFUSALS.find((kind) => failure.message.startsWith(`${kind}:`));
  return reason ? new ApiError(409, "CONFLICT", failure.message, { details: { reason } }) : failure;
}

function reasonOf(error: ApiError): string {
  return (error.details as { reason?: string } | undefined)?.reason ?? error.code;
}
