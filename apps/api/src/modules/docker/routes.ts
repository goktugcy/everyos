import type {
  ComposeProjectView,
  ContainerDetail,
  DockerContainerView,
  DockerOwnership,
} from "@everyos/shared";
import {
  ComposeActionRequestSchema,
  ComposeProjectNameSchema,
  ContainerActionRequestSchema,
  ContainerIdSchema,
  ContainerLogsQuerySchema,
  ImageIdSchema,
  NetworkIdSchema,
  VolumeNameSchema,
  VolumeRemoveRequestSchema,
} from "@everyos/shared/schemas";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context.ts";
import { agentActor, callAgent, toApiError } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { openEventStream } from "../../http/event-stream.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

const IdParams = z.strictObject({ id: ContainerIdSchema });
const ImageParams = z.strictObject({ id: ImageIdSchema });
const NetworkParams = z.strictObject({ id: NetworkIdSchema });
const VolumeParams = z.strictObject({ name: VolumeNameSchema });
const ProjectParams = z.strictObject({ name: ComposeProjectNameSchema });
const EmptyQuery = z.strictObject({});
const ImportRequestSchema = z.strictObject({
  /** Required when another tool (CasaOS, Portainer…) appears to manage the project. */
  acknowledgeManager: z.boolean().optional(),
});

/** A snapshot older than this is refreshed before answering a one-off request. */
const STATS_MAX_AGE_MS = 10_000;

export function dockerRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const projects = services.dockerProjects;

  /** Ownership comes only from EveryOS's records, never from container labels. */
  const ownershipOf = (project: string | null): DockerOwnership =>
    project !== null && services.apps.owns(project)
      ? "managed"
      : project !== null && projects.get(project)
        ? "imported"
        : "external";

  const audit = (
    c: Context<AppEnv>,
    action: string,
    outcome: "success" | "failure" | "denied",
    target: string,
    details?: Record<string, unknown>,
  ) => {
    const auth = requireAuth(c);
    services.audit.record({
      action,
      outcome,
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
      target,
      ...(details ? { details } : {}),
    });
  };

  /** Runs a mutation through the agent and records the outcome in the audit log. */
  const audited = async <T>(
    c: Context<AppEnv>,
    action: string,
    target: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    try {
      const result = await run();
      audit(c, action, "success", target);
      return result;
    } catch (error) {
      const denied = error instanceof ApiError && error.status === 403;
      const reason =
        error instanceof ApiError
          ? ((error.details as { reason?: string } | undefined)?.reason ?? error.code)
          : "INTERNAL_ERROR";
      audit(c, action, denied ? "denied" : "failure", target, { reason });
      throw error;
    }
  };

  app.get("/", requirePermission("docker:read"), async (c) => {
    parseQuery(c, EmptyQuery);
    return c.json(await callAgent(c, services, "docker.status", {}));
  });

  /* ------------------------------ containers ------------------------------ */

  app.get("/containers", requirePermission("docker:read"), async (c) => {
    parseQuery(c, EmptyQuery);
    const list = await callAgent(c, services, "docker.containers.list", {});
    const containers: DockerContainerView[] = list.containers.map((container) => ({
      ...container,
      ownership: ownershipOf(container.project),
    }));
    return c.json({ source: list.source, containers });
  });

  app.get("/containers/:id", requirePermission("docker:read"), async (c) => {
    parseQuery(c, EmptyQuery);
    const { id } = parseParams(c, IdParams);
    const detail: ContainerDetail = await callAgent(c, services, "docker.containers.get", { id });
    return c.json({ ...detail, ownership: ownershipOf(detail.project) });
  });

  app.post("/containers/:id/actions", requirePermission("docker:manage"), async (c) => {
    parseQuery(c, EmptyQuery);
    const { id } = parseParams(c, IdParams);
    const { action } = await parseJsonBody(c, ContainerActionRequestSchema);
    const list = await callAgent(c, services, "docker.containers.list", {});
    const name =
      list.containers.find((container) => container.id.startsWith(id))?.name ?? id.slice(0, 12);
    await audited(c, `docker.containers.${action}`, name, () =>
      callAgent(c, services, "docker.containers.control", { id, action }),
    );
    return c.json({ accepted: true }, 202);
  });

  /**
   * Container logs as server-sent events (`line`), then `end` when the
   * requested backlog is done (or the agent ends a followed stream).
   */
  app.get(
    "/containers/:id/logs",
    requirePermission("docker:read"),
    requirePermission("logs:read"),
    (c) => {
      const { id } = parseParams(c, IdParams);
      const query = parseQuery(c, ContainerLogsQuerySchema);
      const actor = agentActor(requireAuth(c), c.get("client").ip);
      return openEventStream(c, services, {
        permissions: ["docker:read", "logs:read"],
        describeError: (error) => toApiError(error).code,
        async run({ signal, send }) {
          const params = {
            id,
            tail: query.tail,
            follow: query.follow,
            ...(query.since !== undefined ? { since: query.since } : {}),
          };
          for await (const line of services.agent.stream("docker.containers.logs", params, actor, {
            signal,
          })) {
            await send("line", line);
          }
          if (!signal.aborted) await send("end", {});
        },
      });
    },
  );

  app.get("/containers/:id/stats", requirePermission("docker:read"), (c) => {
    parseQuery(c, EmptyQuery);
    const { id } = parseParams(c, IdParams);
    return c.json(services.docker.history(id));
  });

  app.get("/stats", requirePermission("docker:read"), async (c) => {
    parseQuery(c, EmptyQuery);
    const latest = services.docker.latest;
    if (!latest || services.now() - latest.at > STATS_MAX_AGE_MS) await services.docker.sample();
    const snapshot = services.docker.latest;
    if (!snapshot)
      throw new ApiError(503, "AGENT_UNAVAILABLE", "No container statistics available yet");
    return c.json(snapshot);
  });

  /* ----------------------- images, volumes, networks ----------------------- */

  app.get("/images", requirePermission("docker:read"), async (c) => {
    parseQuery(c, EmptyQuery);
    return c.json(await callAgent(c, services, "docker.images.list", {}));
  });

  app.delete("/images/:id", requirePermission("docker:manage"), async (c) => {
    parseQuery(c, EmptyQuery);
    await rejectBody(c);
    const { id } = parseParams(c, ImageParams);
    await audited(c, "docker.images.remove", id.replace("sha256:", "").slice(0, 12), () =>
      callAgent(c, services, "docker.images.remove", { id }),
    );
    return c.body(null, 204);
  });

  app.get("/volumes", requirePermission("docker:read"), async (c) => {
    parseQuery(c, EmptyQuery);
    return c.json(await callAgent(c, services, "docker.volumes.list", {}));
  });

  app.delete("/volumes/:name", requirePermission("docker:delete"), async (c) => {
    parseQuery(c, EmptyQuery);
    const { name } = parseParams(c, VolumeParams);
    const { confirmName } = await parseJsonBody(c, VolumeRemoveRequestSchema);
    if (confirmName !== name)
      throw new ApiError(
        400,
        "VALIDATION_FAILED",
        "The confirmation does not match the volume name",
      );
    await audited(c, "docker.volumes.remove", name, () =>
      callAgent(c, services, "docker.volumes.remove", { name }),
    );
    return c.body(null, 204);
  });

  app.get("/networks", requirePermission("docker:read"), async (c) => {
    parseQuery(c, EmptyQuery);
    return c.json(await callAgent(c, services, "docker.networks.list", {}));
  });

  app.delete("/networks/:id", requirePermission("docker:manage"), async (c) => {
    parseQuery(c, EmptyQuery);
    await rejectBody(c);
    const { id } = parseParams(c, NetworkParams);
    await audited(c, "docker.networks.remove", id.slice(0, 12), () =>
      callAgent(c, services, "docker.networks.remove", { id }),
    );
    return c.body(null, 204);
  });

  /* -------------------------------- compose -------------------------------- */

  app.get("/projects", requirePermission("docker:read"), async (c) => {
    parseQuery(c, EmptyQuery);
    const discovered = await callAgent(c, services, "docker.compose.projects", {});
    const imported = new Map(projects.list().map((project) => [project.name, project]));
    const views: ComposeProjectView[] = discovered.projects.map((project) => {
      const record = imported.get(project.name);
      imported.delete(project.name);
      return {
        ...project,
        ownership: services.apps.owns(project.name) ? "managed" : record ? "imported" : "external",
        importedAt: record?.importedAt ?? null,
        importedBy: record?.importedByUsername ?? null,
      };
    });
    // Imported projects without containers (e.g. after `down`) stay manageable.
    for (const record of imported.values()) {
      views.push({
        name: record.name,
        workingDir: record.workingDir,
        configFiles: record.configFiles,
        services: [],
        containers: { total: 0, running: 0 },
        managerHint: null,
        ownership: "imported",
        importedAt: record.importedAt,
        importedBy: record.importedByUsername,
      });
    }
    views.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ source: discovered.source, projects: views });
  });

  /** Validates the project's Compose files on the host, then records the import. */
  app.post("/projects/:name/import", requirePermission("docker:manage"), async (c) => {
    parseQuery(c, EmptyQuery);
    const auth = requireAuth(c);
    const { name } = parseParams(c, ProjectParams);
    const { acknowledgeManager } = await parseJsonBody(c, ImportRequestSchema);
    if (services.apps.owns(name))
      throw new ApiError(409, "CONFLICT", "Use the App Store to manage this application");
    const discovered = (await callAgent(c, services, "docker.compose.projects", {})).projects.find(
      (project) => project.name === name,
    );
    if (!discovered) throw new ApiError(404, "NOT_FOUND", "Compose project not found");
    if (discovered.managerHint && acknowledgeManager !== true) {
      throw new ApiError(409, "CONFLICT", "Another tool appears to manage this project", {
        details: { managerHint: discovered.managerHint },
      });
    }
    const check = await callAgent(c, services, "docker.compose.check", { project: name });
    if (!check.workingDir || check.files.length === 0 || check.files.some((file) => !file.ok)) {
      audit(c, "docker.projects.import", "failure", name, { files: check.files });
      throw new ApiError(
        422,
        "VALIDATION_FAILED",
        "The project's Compose files could not be validated",
        {
          details: { files: check.files },
        },
      );
    }
    projects.importProject(
      { name, workingDir: check.workingDir, configFiles: check.files.map((file) => file.path) },
      auth.user.id,
    );
    audit(c, "docker.projects.import", "success", name, {
      configFiles: check.files.map((file) => file.path),
      ...(discovered.managerHint ? { managerHint: discovered.managerHint } : {}),
    });
    return c.json({ imported: true, files: check.files }, 201);
  });

  app.delete("/projects/:name/import", requirePermission("docker:manage"), async (c) => {
    parseQuery(c, EmptyQuery);
    await rejectBody(c);
    const { name } = parseParams(c, ProjectParams);
    if (!projects.remove(name)) throw new ApiError(404, "NOT_FOUND", "Project is not imported");
    audit(c, "docker.projects.unimport", "success", name);
    return c.body(null, 204);
  });

  app.post("/projects/:name/actions", requirePermission("docker:manage"), async (c) => {
    parseQuery(c, EmptyQuery);
    const { name } = parseParams(c, ProjectParams);
    const { action } = await parseJsonBody(c, ComposeActionRequestSchema);
    const record = projects.get(name);
    if (!record) {
      audit(c, `docker.projects.${action}`, "denied", name, { reason: "NOT_IMPORTED" });
      throw new ApiError(409, "CONFLICT", "Only imported Compose projects can be managed");
    }
    let result;
    try {
      result = await callAgent(c, services, "docker.compose.run", {
        project: name,
        workingDir: record.workingDir,
        configFiles: record.configFiles,
        action,
      });
    } catch (error) {
      const denied = error instanceof ApiError && error.status === 403;
      audit(c, `docker.projects.${action}`, denied ? "denied" : "failure", name, {
        reason: error instanceof ApiError ? error.code : "INTERNAL_ERROR",
      });
      throw error;
    }
    // One audit entry with the real outcome: Compose can run and still fail.
    audit(c, `docker.projects.${action}`, result.ok ? "success" : "failure", name, {
      ...(result.ok ? {} : { reason: "COMPOSE_FAILED" }),
    });
    // Compose ran; `ok: false` with its output tells the client what went wrong.
    return c.json(result);
  });

  return app;
}

async function rejectBody(c: Context<AppEnv>): Promise<void> {
  if ((await c.req.text()).length > 0)
    throw new ApiError(400, "VALIDATION_FAILED", "This endpoint does not accept a body");
}
