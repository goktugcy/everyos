import type { BackupJobView, BackupView } from "@otuken/shared";
import type { TFunction } from "i18next";
import { reasonText } from "../../notifications/content.ts";

/** What a backup holds, as short labels. */
export function contentLabels(t: TFunction, backup: BackupView): string[] {
  const labels = [t("backups.contents.database")];
  if (backup.contents.config) labels.push(t("backups.contents.config"));
  if (backup.contents.wallpapers) labels.push(t("backups.contents.wallpapers"));
  if (backup.contents.homes?.length)
    labels.push(t("backups.contents.homes", { count: backup.contents.homes.length }));
  const skipped = backup.contents.homes?.reduce((sum, home) => sum + home.skipped, 0) ?? 0;
  if (skipped) labels.push(t("backups.contents.homesSkipped", { count: skipped }));
  const apps = backup.contents.apps.filter((app) => app.data).length;
  if (apps) labels.push(t("backups.contents.apps", { count: apps }));
  return labels;
}

/** A job's error as a sentence. */
export function jobError(t: TFunction, error: string | null): string {
  return error ? reasonText(t, error) : "";
}

/** The current stage of a running job, e.g. "Uygulama verisi kopyalanıyor: Notes". */
export function stageText(
  t: TFunction,
  job: BackupJobView,
  appName: (id: string) => string,
): string {
  const stage = t(`backups.stages.${job.stage}`);
  return job.appId ? `${stage}: ${appName(job.appId)}` : stage;
}

/** Verification problem codes such as "checksum:otuken.db.gz" as text. */
export function verificationText(t: TFunction, error: string | null): string {
  if (!error) return "";
  const [kind, file] = error.split(":");
  return t(`backups.verifyErrors.${kind as "checksum"}`, {
    file: file ?? "",
    defaultValue: error,
  });
}
