import { Hono, type Context } from "hono";
import {
  ArchiveCreateRequestSchema,
  ArchiveExtractRequestSchema,
  FileLocationQuerySchema,
} from "@everyos/shared/schemas";
import type { AppEnv } from "../../context.ts";
import { agentActor } from "../../http/agent.ts";
import { ApiError } from "../../http/errors.ts";
import { parseJsonBody, parseQuery } from "../../http/validation.ts";
import { requireAuth, requirePermission } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";
import type { TransferTask } from "../transfers/transfer-service.ts";
import { fileViewFor } from "./file-view.ts";
import { openZip, zipLimit } from "./zip-reader.ts";
import { createZipTask, extractZipTask, vacant } from "./zip-tasks.ts";

export function fileArchiveRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requirePermission("files:read"));
  const files = (c: Context<AppEnv>, signal?: AbortSignal) => {
    const auth = requireAuth(c);
    return fileViewFor(
      services,
      {
        user: auth.user,
        permissions: auth.permissions,
        actor: agentActor(auth, c.get("client").ip),
      },
      { signal, logger: c.get("logger") },
    );
  };
  app.get("/", async (c) => {
    const { root, path } = parseQuery(c, FileLocationQuerySchema);
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]);
    const archive = await openZip(files(c, signal), root, path, signal).catch((error: unknown) => {
      if (signal.aborted && !c.req.raw.signal.aborted) throw zipLimit();
      throw error;
    });
    try {
      return c.json(archive.listing);
    } finally {
      await archive.close();
    }
  });

  const start = async (c: Context<AppEnv>, kind: "compress" | "extract") => {
    const createInput =
      kind === "compress" ? await parseJsonBody(c, ArchiveCreateRequestSchema) : null;
    const input = createInput ?? (await parseJsonBody(c, ArchiveExtractRequestSchema));
    const auth = requireAuth(c);
    const view = files(c, c.req.raw.signal);
    const roots = await view.roots(true);
    const root = roots.find((entry) => entry.id === input.root);
    if (!root) throw new ApiError(404, "NOT_FOUND", "Location not found");
    if (root.readOnly) throw new ApiError(403, "FILES_READ_ONLY", "This location is read-only");
    const parent = kind === "compress" ? input.path : input.path.split("/").slice(0, -1).join("/");
    await vacant(view, input.root, parent, input.name);
    const target = [parent, input.name].filter(Boolean).join("/");
    const label = (path: string) => [root.name, ...path.split("/").filter(Boolean)].join(" › ");
    const options = {
      root: input.root,
      path: input.path,
      name: input.name,
      ...(input.password !== undefined ? { password: input.password } : {}),
      files: (signal?: AbortSignal) => files(c, signal),
      withAccess: <T>(run: () => Promise<T>) => services.files.withAccess(auth.user.id, run),
      from: label(input.path),
      to: label(target),
    };
    const task = createInput
      ? createZipTask({
          ...options,
          paths: createInput.paths,
          minFreeBytes: services.config.files.minFreeBytes,
        })
      : extractZipTask(options);
    const run = task.run.bind(task);
    const audited: TransferTask = {
      ...task,
      async run(progress, signal) {
        let succeeded = false;
        try {
          await run(progress, signal);
          succeeded = true;
        } catch (error) {
          if (
            error instanceof Error &&
            (error.name === "TimeoutError" ||
              (error.cause instanceof Error && error.cause.name === "TimeoutError"))
          )
            throw zipLimit();
          throw error;
        } finally {
          services.audit.record({
            action: `files.archive.${kind}.finished`,
            outcome: succeeded ? "success" : "failure",
            target: `${input.root}:${target}`,
            actor: { userId: auth.user.id, username: auth.user.username },
            ip: c.get("client").ip,
            details: { cancelled: signal.aborted },
          });
        }
      },
    };
    const transfer = services.transfers.start(auth.user.id, audited);
    services.audit.record({
      action: `files.archive.${kind}`,
      outcome: "success",
      target: transfer.id,
      actor: { userId: auth.user.id, username: auth.user.username },
      ip: c.get("client").ip,
    });
    return c.json({ transfer }, 202);
  };
  app.post("/create", requirePermission("files:write"), (c) => start(c, "compress"));
  app.post("/extract", requirePermission("files:write"), (c) => start(c, "extract"));
  return app;
}
