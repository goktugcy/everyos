import type { SelfUpdateStatus } from "@everyos/shared";

const RECEIPT_KEY = "everyos.completed-update-reload";

/** A successful worker job alone is insufficient: the new API must report its target version. */
export function createUpdateReload(options: {
  currentVersion: string;
  storage: Pick<Storage, "getItem" | "setItem">;
  beforeReload: () => Promise<void>;
  reload: () => void;
}) {
  let claimed = false;
  return async (status: SelfUpdateStatus): Promise<void> => {
    const job = status.job;
    if (
      claimed ||
      !job ||
      job.state !== "succeeded" ||
      job.finishedAt === null ||
      status.installedVersion !== job.version ||
      status.installedVersion === options.currentVersion
    )
      return;
    try {
      if (options.storage.getItem(RECEIPT_KEY) === job.id) return;
    } catch {
      /* Private browser modes can refuse session storage. The in-memory guard still applies. */
    }
    claimed = true;
    try {
      await options.beforeReload();
    } catch {
      claimed = false;
      return;
    }
    try {
      options.storage.setItem(RECEIPT_KEY, job.id);
    } catch {
      /* A fresh bundle also prevents repeated reloads when storage is unavailable. */
    }
    options.reload();
  };
}
