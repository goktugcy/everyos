import type { TaskType } from "@everyos/shared";
import type { AgentGateway } from "../../services.ts";
import type { AppService } from "../apps/app-service.ts";
import type { BackupService } from "../backups/backup-service.ts";
import type { UpdateService } from "../updates/update-service.ts";
import { TaskFailure, type TaskExecutor } from "./task-service.ts";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** The predefined actions tasks may run; each uses the same checks as the interactive feature. */
export function taskExecutors(deps: {
  agent: AgentGateway;
  updates: UpdateService;
  apps: AppService;
  backups?: BackupService;
}): Partial<Record<TaskType, TaskExecutor>> {
  const { agent, updates, apps, backups } = deps;
  const runUpdateJob = async (
    action: "refresh" | "upgrade",
    packages: string[] | null,
    actor: Parameters<TaskExecutor>[1],
    signal: AbortSignal,
  ) => {
    let job;
    try {
      job = updates.start(action, packages, actor);
    } catch {
      throw new TaskFailure("busy");
    }
    const done = await updates.wait(job.id, signal);
    if (done.status !== "succeeded") throw new TaskFailure(done.error ?? done.status);
    return done;
  };
  return {
    "updates.refresh": async (_params, actor, signal) => {
      await runUpdateJob("refresh", null, actor, signal);
      return { summary: null };
    },
    "updates.security": async (_params, actor, signal) => {
      const list = await agent.call("apt.updates", {}, actor, { signal });
      const security = list.packages.filter((p) => p.security).map((p) => p.name);
      if (security.length === 0) return { summary: "0" };
      const done = await runUpdateJob("upgrade", security, actor, signal);
      return { summary: String(done.upgraded ?? 0) };
    },
    "service.restart": async ({ unit }, actor, signal) => {
      await agent.call("services.control", { unit: unit!, action: "restart" }, actor, { signal });
      return { summary: null };
    },
    "container.restart": async ({ container }, actor, signal) => {
      const { containers } = await agent.call("docker.containers.list", {}, actor, { signal });
      const target = containers.find((c) => c.name === container);
      if (!target) throw new TaskFailure("not-found");
      await agent.call("docker.containers.control", { id: target.id, action: "restart" }, actor, {
        signal,
      });
      return { summary: null };
    },
    "backup.create": async (_params, actor, signal) => {
      if (!backups) throw new TaskFailure("unsupported");
      // The saved settings decide which apps' data is included (apps removed since are skipped).
      const settings = backups.settings();
      let job;
      try {
        job = backups.create(
          {
            apps: settings.appData.filter((id) => apps.dataSupport(id) === "supported"),
            trigger: "schedule",
          },
          actor,
        );
      } catch (caught) {
        throw new TaskFailure(
          (caught as { code?: string }).code === "BACKUP_BUSY" ? "busy" : "failed",
        );
      }
      const done = await backups.wait(job.id, signal);
      if (done.status !== "succeeded") throw new TaskFailure(done.error ?? done.status);
      return { summary: done.backupId };
    },
    "app.update": async ({ appId }, actor, signal) => {
      let job;
      try {
        job = await apps.control(appId!, "update", actor);
      } catch (caught) {
        throw new TaskFailure((caught as { code?: string }).code ?? "failed");
      }
      while (!signal.aborted) {
        const current = apps.job(job.id);
        if (current?.stage === "succeeded") return { summary: null };
        if (current?.stage === "failed") throw new TaskFailure(current.error ?? "failed");
        await sleep(1_000, signal);
      }
      return { summary: null };
    },
  };
}
