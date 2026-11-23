import { randomUUID } from "node:crypto";
import {
  networkRootId,
  roleHasPermission,
  type NetworkConnection,
  type NetworkFolderShare,
  type SharingHostStatus,
} from "@everyos/shared";
import { SharingConnectionInputSchema, SharingFolderInputSchema } from "@everyos/shared/schemas";
import type { z } from "zod";
import type { Services } from "../../services.ts";
import { callAgentAs, type UserActor } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { tcpReachable } from "@everyos/security";
import { SftpFiles, SftpPool, resolveNetworkHost, type NetworkCredentials } from "./sftp.ts";

type Draft = z.infer<typeof SharingConnectionInputSchema>;
type ShareDraft = z.infer<typeof SharingFolderInputSchema>;
type Row = {
  id: string;
  user_id: string;
  config: string;
  sealed_credentials: string | null;
  created_at: number;
  updated_at: number;
};
export class NetworkSharingService {
  readonly #services: () => Services;
  readonly pool: SftpPool;
  #probeCount = 0;
  #probeRates = new Map<string, { at: number; count: number }>();
  #hosts = new Map<string, { at: number; value: Promise<SharingHostStatus> }>();
  invalidate() {
    this.#hosts.clear();
    this.#probes.clear();
  }
  #host(actor: UserActor) {
    const key = actor.userId + ":" + actor.role,
      previous = this.#hosts.get(key);
    if (previous && this.services.now() - previous.at < 2000) return previous.value;
    if (this.#hosts.size > 256) this.#hosts.clear();
    const value = callAgentAs(
      this.services,
      actor,
      "sharing.status",
      {},
      { logger: this.services.logger },
    );
    this.#hosts.set(key, { at: this.services.now(), value });
    return value;
  }
  #probes = new Map<string, { at: number; value: Promise<boolean> }>();
  constructor(services: () => Services, options: { allowLoopback?: boolean } = {}) {
    this.#services = services;
    this.pool = new SftpPool(options);
  }
  get services() {
    return this.#services();
  }
  close() {
    this.pool.close();
  }
  audit(
    actor: UserActor,
    action: string,
    target: string,
    outcome: "success" | "failure" = "success",
  ) {
    this.invalidate();
    this.services.audit.record({
      action: "sharing." + action,
      target,
      outcome,
      actor: { userId: actor.userId, username: actor.username },
      ...(actor.ip ? { ip: actor.ip } : {}),
    });
  }
  row(id: string, actor: UserActor) {
    const row = this.services.db.get<Row>(
      "SELECT * FROM network_connections WHERE id = ? AND user_id = ?",
      id,
      actor.userId,
    );
    if (!row) throw new ApiError(404, "NOT_FOUND", "Connection not found");
    return row;
  }
  closeOwner(userId: string) {
    for (const row of this.services.db.all<{ id: string }>(
      "SELECT id FROM network_connections WHERE user_id=?",
      userId,
    ))
      this.pool.close(row.id);
  }
  accountChanged(userId: string) {
    this.closeOwner(userId);
    this.services.db.transaction(() => {
      for (const table of ["network_connections", "network_shares"] as const) {
        for (const row of this.services.db.all<Row>(
          "SELECT * FROM " + table + " WHERE user_id=?",
          userId,
        )) {
          const config = JSON.parse(row.config) as NetworkConnection | NetworkFolderShare;
          if (config.protocol === "sftp") continue;
          this.services.db.run(
            "UPDATE " + table + " SET config=?,updated_at=? WHERE id=?",
            JSON.stringify({ ...config, enabled: false }),
            this.services.now(),
            row.id,
          );
        }
      }
    });
    this.invalidate();
  }
  connections(actor: UserActor): NetworkConnection[] {
    return this.services.db
      .all<Row>(
        "SELECT * FROM network_connections WHERE user_id = ? ORDER BY created_at",
        actor.userId,
      )
      .map((row) => ({
        ...(JSON.parse(row.config) as NetworkConnection),
        id: row.id,
        root: networkRootId(row.id),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        state: "disconnected",
        reason: null,
      }));
  }
  get(id: string, actor: UserActor) {
    return (
      this.connections(actor).find((c) => c.id === id) ??
      (() => {
        throw new ApiError(404, "NOT_FOUND", "Connection not found");
      })()
    );
  }
  credentials(id: string, actor: UserActor): NetworkCredentials {
    const row = this.row(id, actor);
    return row.sealed_credentials
      ? (JSON.parse(
          this.services.secrets.open(
            row.sealed_credentials,
            "network-connection:" + actor.userId + ":" + id,
          ),
        ) as NetworkCredentials)
      : {};
  }
  sftp(connection: NetworkConnection, actor: UserActor, signal?: AbortSignal) {
    if (!connection.enabled) throw new ApiError(409, "SHARING_DISABLED", "Connection disabled");
    return new SftpFiles({
      connection,
      owner: actor.userId,
      pool: this.pool,
      credentials: this.credentials(connection.id, actor),
      signal,
      maxUploadBytes: this.services.config.files.maxUploadBytes,
      minFreeBytes: this.services.config.files.minFreeBytes,
    });
  }
  async #reachable(c: NetworkConnection) {
    const key = c.host + ":" + c.port;
    const previous = this.#probes.get(key);
    if (previous && this.services.now() - previous.at < 5000) return previous.value;
    if (this.#probes.size > 256) this.#probes.clear();
    const address = await resolveNetworkHost(c.host, this.pool.allowLoopback);
    const value = tcpReachable(address, c.port);
    this.#probes.set(key, { at: this.services.now(), value });
    return value;
  }
  async probe(host: string, port: number, protocol: string, owner: string) {
    const now = this.services.now();
    if (this.#probeRates.size > 256)
      for (const [key, value] of this.#probeRates)
        if (value.at + 60000 <= now) this.#probeRates.delete(key);
    let rate = this.#probeRates.get(owner);
    if (!rate || rate.at + 60000 <= now) {
      rate = { at: now, count: 0 };
      this.#probeRates.set(owner, rate);
    }
    if (++rate.count > 12 || this.#probeRates.size > 256)
      throw new ApiError(429, "RATE_LIMITED", "Too many connection probes");
    if (this.#probeCount >= 4)
      throw new ApiError(429, "RATE_LIMITED", "Too many connection probes");
    this.#probeCount++;
    try {
      if (protocol === "sftp")
        return { reachable: true, fingerprint: await this.pool.probe(host, port) };
      return {
        reachable: await tcpReachable(
          await resolveNetworkHost(host, this.pool.allowLoopback),
          port,
        ),
        fingerprint: null,
      };
    } finally {
      this.#probeCount--;
    }
  }
  async status(actor: UserActor, signal?: AbortSignal) {
    const [host, remote] = await Promise.all([
      callAgentAs(
        this.services,
        actor,
        "sharing.status",
        {},
        { signal, logger: this.services.logger },
      ).catch((error: unknown): SharingHostStatus => ({
        source: "host",
        supported: false,
        reason: error instanceof ApiError ? error.code : "AGENT_OPERATION_FAILED",
        services: [],
        mounts: [],
        exports: [],
        externalExports: [],
        sshPorts: [],
        addresses: [],
        installation: null,
      })),
      callAgentAs(
        this.services,
        actor,
        "remoteAccess.snapshot",
        {},
        { signal, logger: this.services.logger },
      ).catch(() => null),
    ]);
    const connections = this.connections(actor);
    // A bounded worker set avoids a socket burst when a person has many saved endpoints.
    for (const c of connections) c.state = c.enabled ? "unknown" : "disabled";
    const deadline = Date.now() + 4000;
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, connections.length) }, async () => {
        for (;;) {
          const c = connections[index++];
          if (!c || Date.now() >= deadline) return;
          if (!c.enabled) {
            c.state = "disabled";
            continue;
          }
          const mount = host.mounts.find((m) => m.id === c.id);
          if (mount) c.mountPoint = mount.target;
          try {
            const online = await this.#reachable(c);
            c.state = !online
              ? "unavailable"
              : (c.protocol === "sftp" ? this.pool.isConnected(c.id) : mount?.mounted)
                ? "connected"
                : "disconnected";
            c.reason = online ? null : "SHARING_UNREACHABLE";
          } catch {
            c.state = "unavailable";
            c.reason = "SHARING_NETWORK_DENIED";
          }
        }
      }),
    );
    return {
      host,
      privateNetworks: remote?.providers ?? [],
      connections,
      shares: this.shares(actor).map((s) => ({
        ...s,
        state: !s.enabled
          ? ("disabled" as const)
          : host.exports.some((e) => e.id === s.id && e.active)
            ? ("connected" as const)
            : ("unavailable" as const),
      })),
    };
  }
  async ensure(connection: NetworkConnection, actor: UserActor, signal?: AbortSignal) {
    if (!connection.enabled) throw new ApiError(409, "SHARING_DISABLED", "Connection disabled");
    if (!(await this.#reachable(connection)))
      throw new ApiError(503, "SHARING_UNREACHABLE", "Network folder unavailable");
    if (connection.protocol !== "sftp") {
      signal?.throwIfAborted();
      const host = await this.#host(actor);
      if (!host.mounts.some((m) => m.id === connection.id && m.mounted)) {
        if (!connection.automount)
          throw new ApiError(409, "SHARING_DISABLED", "Mount this connection first");
        await callAgentAs(
          this.services,
          actor,
          "sharing.mount.access",
          { id: connection.id },
          { signal, logger: this.services.logger },
        );
      }
    }
  }
  async save(draft: Draft, actor: UserActor, id: string = randomUUID()) {
    draft = SharingConnectionInputSchema.parse(draft);
    if (
      !roleHasPermission(actor.role, "files:write") ||
      (draft.protocol !== "sftp" && !roleHasPermission(actor.role, "system:manage"))
    )
      throw new ApiError(403, "FORBIDDEN", "Sharing permission required");
    await resolveNetworkHost(draft.host, this.pool.allowLoopback);
    const previous = this.services.db.get<Row>(
      "SELECT * FROM network_connections WHERE id = ?",
      id,
    );
    if (previous && previous.user_id !== actor.userId)
      throw new ApiError(404, "NOT_FOUND", "Connection not found");
    if (previous && (JSON.parse(previous.config) as NetworkConnection).protocol !== draft.protocol)
      throw new ApiError(400, "VALIDATION_FAILED", "Protocol cannot change");
    if (this.connections(actor).length >= 64 && !previous)
      throw new ApiError(429, "RATE_LIMITED", "Connection limit reached");
    const credentials: NetworkCredentials = {
      ...(previous ? this.credentials(id, actor) : {}),
      ...(draft.password ? { password: draft.password } : {}),
      ...(draft.privateKey ? { privateKey: draft.privateKey } : {}),
      ...(draft.passphrase ? { passphrase: draft.passphrase } : {}),
      ...(draft.domain === undefined ? {} : { domain: draft.domain }),
    };
    if (draft.privateKey) delete credentials.password;
    else if (draft.password) {
      delete credentials.privateKey;
      delete credentials.passphrase;
    }
    if (draft.protocol !== "nfs" && !credentials.password && !credentials.privateKey)
      throw new ApiError(400, "VALIDATION_FAILED", "Credentials required");
    const {
      confirm: _confirm,
      password: _password,
      privateKey: _key,
      passphrase: _phrase,
      domain: _domain,
      ...config
    } = draft;
    let mountPoint: string | null = null;
    try {
      if (draft.protocol !== "sftp")
        mountPoint = (
          await callAgentAs(
            this.services,
            actor,
            "sharing.mount.apply",
            {
              id,
              name: config.name,
              protocol: draft.protocol,
              host: config.host,
              port: config.port,
              remotePath: config.remotePath,
              ...(config.mountName ? { mountName: config.mountName } : {}),
              username: config.username,
              readOnly: config.readOnly,
              enabled: config.enabled,
              automount: config.automount,
              persistent: config.persistent,
              version: draft.version as "4.2" | "4.1" | "4" | "3" | "3.1.1" | "3.0" | "2.1",
              ...(credentials.password ? { password: credentials.password } : {}),
              ...(credentials.domain === undefined ? {} : { domain: credentials.domain }),
            },
            { logger: this.services.logger },
          )
        ).target;
      const now = this.services.now();
      const sealed =
        draft.protocol === "nfs"
          ? null
          : this.services.secrets.seal(
              JSON.stringify(credentials),
              "network-connection:" + actor.userId + ":" + id,
            );
      this.services.db.run(
        "INSERT INTO network_connections (id,user_id,config,sealed_credentials,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,sealed_credentials=excluded.sealed_credentials,updated_at=excluded.updated_at",
        id,
        actor.userId,
        JSON.stringify({ ...config, mountPoint }),
        sealed,
        previous?.created_at ?? now,
        now,
      );
      this.pool.close(id);
      this.audit(actor, previous ? "connection.update" : "connection.create", id);
      return this.get(id, actor);
    } catch (error) {
      this.audit(actor, "connection.save", id, "failure");
      throw error;
    }
  }
  async control(id: string, action: "connect" | "disconnect", actor: UserActor) {
    const c = this.get(id, actor);
    if (c.protocol === "sftp") {
      if (action === "disconnect") this.pool.close(id);
      else {
        const lease = await this.pool.acquire(
          c,
          this.credentials(id, actor),
          undefined,
          actor.userId,
        );
        lease.release();
      }
    } else
      await callAgentAs(
        this.services,
        actor,
        "sharing.mount.control",
        { id, action },
        { logger: this.services.logger },
      );
    this.audit(actor, "connection." + action, id);
  }
  async remove(id: string, actor: UserActor) {
    const c = this.get(id, actor);
    if (c.protocol !== "sftp")
      await callAgentAs(
        this.services,
        actor,
        "sharing.mount.remove",
        { id },
        { logger: this.services.logger },
      ).catch((error: unknown) => {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      });
    this.pool.close(id);
    this.services.db.run(
      "DELETE FROM network_connections WHERE id=? AND user_id=?",
      id,
      actor.userId,
    );
    this.audit(actor, "connection.remove", id);
  }
  shares(actor: UserActor): NetworkFolderShare[] {
    return this.services.db
      .all<{ id: string; config: string; created_at: number }>(
        "SELECT id,config,created_at FROM network_shares WHERE user_id=? ORDER BY created_at",
        actor.userId,
      )
      .map((r) => ({
        ...(JSON.parse(r.config) as NetworkFolderShare),
        id: r.id,
        createdAt: r.created_at,
        state: "disconnected",
        reason: null,
      }));
  }
  async saveShare(input: ShareDraft, actor: UserActor, id: string = randomUUID()) {
    input = SharingFolderInputSchema.parse(input);
    if (!roleHasPermission(actor.role, "system:manage"))
      throw new ApiError(403, "FORBIDDEN", "System management required");
    const old = this.services.db.get<{ user_id: string; config: string }>(
      "SELECT user_id,config FROM network_shares WHERE id=?",
      id,
    );
    if (old && old.user_id !== actor.userId)
      throw new ApiError(404, "NOT_FOUND", "Share not found");
    if (old && (JSON.parse(old.config) as NetworkFolderShare).protocol !== input.protocol)
      throw new ApiError(400, "VALIDATION_FAILED", "Protocol cannot change");
    if (input.protocol === "smb" && !input.users.length) {
      const identity = await callAgentAs(
        this.services,
        actor,
        "identity.status",
        {},
        { logger: this.services.logger },
      );
      if (!identity.account)
        throw new ApiError(403, "AGENT_OPERATION_DENIED", "Link a Linux account first");
      input.users = [identity.account.name];
    }
    await callAgentAs(
      this.services,
      actor,
      "sharing.export.apply",
      { id, ...input },
      { logger: this.services.logger },
    );
    this.services.db.run(
      "INSERT INTO network_shares (id,user_id,config,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,updated_at=excluded.updated_at",
      id,
      actor.userId,
      JSON.stringify(input),
      this.services.now(),
      this.services.now(),
    );
    this.audit(actor, "folder.save", id);
    return this.shares(actor).find((r) => r.id === id)!;
  }
  async removeShare(id: string, actor: UserActor) {
    if (!this.shares(actor).some((r) => r.id === id))
      throw new ApiError(404, "NOT_FOUND", "Share not found");
    await callAgentAs(
      this.services,
      actor,
      "sharing.export.remove",
      { id },
      { logger: this.services.logger },
    ).catch((error: unknown) => {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    });
    this.services.db.run("DELETE FROM network_shares WHERE id=? AND user_id=?", id, actor.userId);
    this.audit(actor, "folder.remove", id);
  }
}
