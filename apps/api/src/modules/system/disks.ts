import type { Actor } from "@everyos/agent-protocol";
import type { Logger } from "@everyos/logger";
import { DISK_REFUSALS, diskRootId, type DiskList } from "@everyos/shared";
import { ApiError } from "../../http/errors.ts";
import { toApiError } from "../../http/agent.ts";
import type { AgentGateway } from "../../services.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { FileRootConfig } from "../files/file-service.ts";

const SYSTEM: Actor = { kind: "system", component: "disks" };
const REFRESH_MS = 30_000;

/**
 * Disks through the agent (docs/disks.md). The last listing also feeds Files, which offers every
 * disk EveryOS mounted as a location.
 */
export class DiskService {
  readonly #agent: AgentGateway;
  readonly #audit: AuditLog;
  readonly #logger: Logger;
  readonly #now: () => number;
  #last: { at: number; list: DiskList } | null = null;
  #refreshing: Promise<unknown> | null = null;

  constructor(deps: { agent: AgentGateway; audit: AuditLog; logger: Logger; now: () => number }) {
    this.#agent = deps.agent;
    this.#audit = deps.audit;
    this.#logger = deps.logger.child({ component: "disks" });
    this.#now = deps.now;
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
    return list;
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
