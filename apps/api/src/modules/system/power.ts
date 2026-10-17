import type { PowerBlocker } from "@everyos/shared";
import type { Context } from "hono";
import type { AppEnv } from "../../context.ts";
import { callAgent } from "../../http/agent.ts";
import type { Services } from "../../services.ts";

const RELEASE_DONE = new Set(["succeeded", "rolled-back", "failed"]);

/** Work a restart or power-off would cut short; an EveryOS update can never be overridden. */
export async function powerBlockers(
  services: Services,
  c: Context<AppEnv>,
): Promise<PowerBlocker[]> {
  const blockers: PowerBlocker[] = [];
  const release = await callAgent(c, services, "release.status", {}).catch(() => null);
  if (release?.job && !RELEASE_DONE.has(release.job.state)) blockers.push("release-install");
  const backup = services.backups.job();
  if (backup?.status === "running") blockers.push(backup.kind === "restore" ? "restore" : "backup");
  if (services.apps.activeJobs() > 0) blockers.push("app-jobs");
  if (services.updates.jobs().some((job) => job.status === "running"))
    blockers.push("package-upgrade");
  if (services.transfers.active() > 0) blockers.push("transfers");
  return blockers;
}
