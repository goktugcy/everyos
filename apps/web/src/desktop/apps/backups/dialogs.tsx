import type { BackupAppOption, BackupSettings, BackupView, RestorePreview } from "@everyos/shared";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes, formatDateTime } from "../../../lib/format.ts";
import { localized } from "../store/parts.tsx";
import { LoadingBlock, ResourceError } from "../system/parts.tsx";
import { verificationText } from "./lib.ts";

function AppChoices({
  apps,
  selected,
  onChange,
  hint,
}: {
  apps: BackupAppOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  hint: string;
}) {
  const { t, i18n } = useTranslation();
  if (apps.length === 0) return <p className="text-xs text-fg-muted">{t("backups.noApps")}</p>;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[0.8rem] font-medium text-fg-muted">
        {t("backups.appData")}
      </legend>
      {apps.map((app) => (
        <label key={app.id} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0"
            disabled={app.data !== "supported"}
            checked={selected.includes(app.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, app.id]
                  : selected.filter((id) => id !== app.id),
              )
            }
          />
          <span className="flex flex-col">
            <span>{localized(app.name, i18n.language) || app.id}</span>
            {app.data !== "supported" ? (
              <span className="text-xs text-fg-muted">{t(`backups.dataSupport.${app.data}`)}</span>
            ) : null}
          </span>
        </label>
      ))}
      <p className="text-xs text-fg-muted">{hint}</p>
    </fieldset>
  );
}

export function CreateDialog({
  apps,
  defaults,
  onClose,
  onStarted,
}: {
  apps: BackupAppOption[];
  defaults: string[];
  onClose: () => void;
  onStarted: () => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(
    defaults.filter((id) => apps.some((app) => app.id === id && app.data === "supported")),
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/backups", {
        method: "POST",
        body: { apps: selected, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      onStarted();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t("backups.create")}>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <p className="text-sm text-fg-muted">{t("backups.createIntro")}</p>
        <Field
          label={t("backups.note")}
          value={note}
          maxLength={200}
          placeholder={t("backups.notePlaceholder")}
          onChange={(event) => setNote(event.target.value)}
        />
        <AppChoices
          apps={apps}
          selected={selected}
          onChange={setSelected}
          hint={t("backups.stopHint")}
        />
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={busy}>
            {t("backups.start")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function SettingsDialog({
  settings,
  apps,
  onClose,
  onSaved,
}: {
  settings: BackupSettings;
  apps: BackupAppOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [keep, setKeep] = useState(String(settings.keep));
  const [appData, setAppData] = useState(
    settings.appData.filter((id) => apps.some((app) => app.id === id && app.data === "supported")),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const count = Number(keep);
  const valid = Number.isInteger(count) && count >= 1 && count <= 100;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/backups/settings", { method: "PUT", body: { keep: count, appData } });
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t("backups.settings")}>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <Field
          label={t("backups.keep")}
          hint={t("backups.keepHint")}
          type="number"
          min={1}
          max={100}
          value={keep}
          onChange={(event) => setKeep(event.target.value)}
        />
        <AppChoices
          apps={apps}
          selected={appData}
          onChange={setAppData}
          hint={t("backups.scheduledAppsHint")}
        />
        <Alert tone="info">{t("backups.scheduleHint")}</Alert>
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={busy} disabled={!valid}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function DownloadDialog({
  backup,
  encryption,
  onClose,
}: {
  backup: BackupView;
  /** A backup passphrase is set (null while unknown). */
  encryption: boolean | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [encrypted, setEncrypted] = useState(encryption === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>(`/backups/${backup.id}/download`, {
        method: "POST",
        body: { password, encrypted },
      });
      const link = document.createElement("a");
      link.href = url;
      link.download = `everyos-backup-${backup.id}.${encrypted ? "eosbak" : "tar"}`;
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("backups.download")}
      description={t("backups.downloadIntro")}
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {encrypted ? null : <Alert tone="warning">{t("backups.downloadWarning")}</Alert>}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0"
            checked={encrypted}
            disabled={encryption !== true}
            onChange={(event) => setEncrypted(event.target.checked)}
            data-testid="backup-download-encrypted"
          />
          <span className="flex flex-col">
            <span>{t("backups.secure.encryptDownload")}</span>
            <span className="text-xs text-fg-muted">
              {encryption === true
                ? t("backups.secure.encryptDownloadHint")
                : t("backups.secure.encryptDownloadOff")}
            </span>
          </span>
        </label>
        <Field
          label={t("backups.password")}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={busy} disabled={!password}>
            {t("backups.download")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const STATUS_CLASS = {
  same: "text-fg-muted",
  added: "text-success",
  removed: "text-danger",
} as const;

export function RestoreDialog({
  backup,
  supervised,
  onClose,
  onStarted,
}: {
  backup: BackupView;
  supervised: boolean;
  onClose: () => void;
  onStarted: () => void;
}) {
  const { t, i18n } = useTranslation();
  const preview = useApiResource<RestorePreview>(`/backups/${backup.id}/preview`, null);
  const [settings, setSettings] = useState<"none" | "desktop" | "database">("none");
  const [apps, setApps] = useState<string[]>([]);
  const [homes, setHomes] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const data = preview.data;
  const nothing = settings === "none" && apps.length === 0 && !homes;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/backups/${backup.id}/restore`, {
        method: "POST",
        body: { settings, apps, homes, password, confirm: true },
      });
      onStarted();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const option = (
    value: "none" | "desktop" | "database",
    label: string,
    hint: string,
    disabled = false,
  ) => (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="radio"
        name="restore-settings"
        className="mt-0.5 size-4 shrink-0"
        checked={settings === value}
        disabled={disabled}
        onChange={() => setSettings(value)}
      />
      <span className="flex flex-col">
        <span>{label}</span>
        <span className="text-xs text-fg-muted">{hint}</span>
      </span>
    </label>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("backups.restoreTitle")}
      description={t("backups.restoreFrom", {
        date: formatDateTime(backup.createdAt, i18n.language),
      })}
      className="w-[min(94vw,640px)]"
    >
      <ResourceError error={preview.error} />
      {preview.loading ? <LoadingBlock /> : null}
      {data ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
          data-testid="restore-dialog"
        >
          {data.verification.ok ? (
            <Alert tone="success">{t("backups.verified")}</Alert>
          ) : (
            <Alert tone="danger">
              {t("backups.verifyFailed", {
                reason: verificationText(t, data.verification.error),
              })}
            </Alert>
          )}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[0.8rem] font-medium text-fg-muted">
              {t("backups.restoreSettings")}
            </legend>
            {option("none", t("backups.scope.none"), t("backups.scope.noneHint"))}
            {option(
              "desktop",
              t("backups.scope.desktop"),
              t("backups.scope.desktopHint", { users: data.desktopUsers.join(", ") || "—" }),
              data.desktopUsers.length === 0 || !data.verification.ok,
            )}
            {option(
              "database",
              t("backups.scope.database"),
              data.databaseBlocked
                ? t(`backups.blocked.${data.databaseBlocked as "invalid"}`, {
                    defaultValue: data.databaseBlocked,
                  })
                : supervised
                  ? t("backups.scope.databaseHintAutomatic")
                  : t("backups.scope.databaseHintManual"),
              data.databaseBlocked !== null,
            )}
          </fieldset>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0"
              checked={homes}
              disabled={
                !data.verification.ok || !data.homes.some((home) => home.restorable === "ok")
              }
              onChange={(event) => setHomes(event.target.checked)}
            />
            <span className="flex flex-col">
              <span>{t("backups.restoreHomes")}</span>
              <span className="text-xs text-fg-muted">
                {data.homes.some((home) => home.restorable === "ok")
                  ? t("backups.restoreHomesHint", {
                      users: data.homes
                        .filter((home) => home.restorable === "ok")
                        .map((home) => home.username)
                        .join(", "),
                    })
                  : t("backups.homesUnavailable")}
              </span>
            </span>
          </label>
          {settings === "database" ? (
            <div
              className="rounded-everyos-md border border-line p-3 text-xs"
              data-testid="restore-diff"
            >
              <p className="mb-1 font-semibold">{t("backups.diff.users")}</p>
              <ul className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
                {data.database.users.map((user) => (
                  <li key={user.username} className={STATUS_CLASS[user.status]}>
                    {user.username} ({t(`backups.diff.${user.status}`)})
                  </li>
                ))}
              </ul>
              <p className="mb-1 font-semibold">{t("backups.diff.apps")}</p>
              {data.database.apps.length ? (
                <ul className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
                  {data.database.apps.map((app) => (
                    <li key={app.id} className={STATUS_CLASS[app.status]}>
                      {localized(app.name, i18n.language) || app.id} (
                      {t(`backups.diff.${app.status}`)})
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mb-2 text-fg-muted">—</p>
              )}
              <p className="text-fg-muted">
                {t("backups.diff.summary", {
                  tasks: data.database.tasks,
                  catalogs: data.database.catalogs,
                })}
              </p>
              {data.database.schemaVersion < data.database.currentSchemaVersion ? (
                <p className="mt-1 text-fg-muted">{t("backups.diff.migrate")}</p>
              ) : null}
            </div>
          ) : null}
          {data.apps.length ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[0.8rem] font-medium text-fg-muted">
                {t("backups.restoreApps")}
              </legend>
              {data.apps.map((app) => (
                <label key={app.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0"
                    disabled={app.restorable !== "ok" || !data.verification.ok}
                    checked={apps.includes(app.id)}
                    onChange={(event) =>
                      setApps(
                        event.target.checked
                          ? [...apps, app.id]
                          : apps.filter((id) => id !== app.id),
                      )
                    }
                  />
                  <span className="flex flex-col">
                    <span>
                      {localized(app.name, i18n.language) || app.id} ·{" "}
                      {formatBytes(app.dataBytes, i18n.language)}
                    </span>
                    {app.restorable !== "ok" ? (
                      <span className="text-xs text-fg-muted">
                        {t(`backups.restorable.${app.restorable}`)}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
              <p className="text-xs text-fg-muted">{t("backups.restoreAppsHint")}</p>
            </fieldset>
          ) : null}
          {data.config === "different" ? (
            <Alert tone="info">{t("backups.configDifferent")}</Alert>
          ) : null}
          <Alert tone="warning">{t("backups.safetyHint")}</Alert>
          <Field
            label={t("backups.password")}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {t("backups.confirmRestore")}
          </label>
          {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="danger"
              loading={busy}
              disabled={nothing || !password || !confirmed || !data.verification.ok}
            >
              {t("backups.restore")}
            </Button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}
