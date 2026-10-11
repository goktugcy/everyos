import type { AppJobView, CatalogAppView, InstalledAppView } from "@everyos/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { api } from "../../../lib/api.ts";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { usePermissions, useSessionStore } from "../../../stores/session-store.ts";
import { ResourceError } from "../system/parts.tsx";
import { localized } from "./parts.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { requestConfirm } from "../../menus/confirm.tsx";

export function InstallDialog({
  app,
  onClose,
  onJob,
  sources,
}: {
  app: CatalogAppView;
  onClose: () => void;
  onJob: (job: AppJobView) => void;
  sources: InstalledAppView[];
}) {
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const admin = useSessionStore((state) => state.session?.user.role === "admin");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [dataFrom, setDataFrom] = useState("");
  const privileged = app.risks.some(
    (risk) => risk !== "unpinned-image" && risk !== "default-secret",
  );
  const submit = async () => {
    if (
      dataFrom &&
      !(await requestConfirm({
        title: t("appStore.copyConfirmTitle"),
        body: t("appStore.copyConfirmBody"),
        confirmLabel: t("appStore.install"),
      }))
    )
      return;
    setPending(true);
    setError(null);
    try {
      const job = await api<AppJobView>("/apps/install", {
        method: "POST",
        body: {
          appId: app.id,
          snapshot: app.source.ref,
          variables: Object.fromEntries(
            Object.entries(variables).filter(([, value]) => value !== ""),
          ),
          ports: app.ports.map((port) => ({
            service: port.service,
            index: port.index,
            host: Number(
              ports[`${port.service}:${port.index}`] ??
                (port.host && port.host >= 1024 ? port.host : 8080),
            ),
          })),
          acknowledgeRisks: acknowledged,
          ...(dataFrom ? { dataFrom, confirmDataFrom: dataFrom } : {}),
        },
      });
      onJob(job);
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={localized(app.name, i18n.language)}
    >
      <form
        className="flex flex-col gap-4 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="whitespace-pre-wrap text-fg-muted">
          {localized(app.description, i18n.language)}
        </p>
        {app.notes && Object.keys(app.notes).length ? (
          <Alert tone="info">{localized(app.notes, i18n.language)}</Alert>
        ) : null}
        {app.links ? (
          <div className="flex flex-wrap gap-3 text-xs">
            {(["documentation", "website", "repository"] as const).map((key) =>
              app.links[key] ? (
                <a
                  key={key}
                  href={app.links[key]}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent underline"
                >
                  {t(`appStore.links.${key}`)}
                </a>
              ) : null,
            )}
          </div>
        ) : null}
        {app.screenshots?.length ? (
          <div className="flex gap-3 overflow-x-auto">
            {app.screenshots.map((url, index) => (
              <img
                key={url}
                src={url}
                loading="lazy"
                alt={t("appStore.screenshot", { index: index + 1 })}
                className="h-36 max-w-64 shrink-0 rounded-everyos-sm object-contain"
              />
            ))}
          </div>
        ) : null}
        <dl className="flex flex-col gap-2 text-xs">
          <dt className="font-medium">{t("appStore.images")}</dt>
          <dd className="break-all font-mono text-fg-muted">{app.images.join(", ")}</dd>
          <dt className="font-medium">{t("appStore.architecture")}</dt>
          <dd>{app.architectures.join(", ") || t("appStore.unknownArchitecture")}</dd>
          <dt className="font-medium">{t("appStore.provenance")}</dt>
          <dd className="break-all font-mono text-fg-subtle">
            {app.source.format} · {app.source.path} · {app.source.ref}
          </dd>
        </dl>
        {app.mounts?.length ? (
          <div className="flex flex-col gap-2 text-xs">
            <p className="font-medium">{t("appStore.mounts")}</p>
            <ul className="flex flex-col gap-2">
              {app.mounts.map((mount, index) => (
                <li key={`${mount.service}:${index}`} className="break-all">
                  <code>
                    {mount.service} · {mount.source ?? t("appStore.anonymousVolume")} →{" "}
                    {mount.target}
                  </code>
                  <span className="ml-2 text-fg-muted">
                    {t(mount.readOnly ? "appStore.readOnly" : "appStore.readWrite")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {app.blockers.length ? (
          <Alert tone="danger" title={t("appStore.unsupported")}>
            <ul>
              {app.blockers.map((feature) => (
                <li key={feature}>{t("appStore.blocker", { feature })}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {app.risks.length ? (
          <Alert tone="warning" title={t("appStore.riskTitle")}>
            <ul className="list-inside list-disc">
              {app.risks.map((risk) => (
                <li key={risk}>{t(`appStore.risks.${risk}`)}</li>
              ))}
            </ul>
            {privileged && !admin ? <p className="mt-2">{t("appStore.adminRequired")}</p> : null}
            <label className="mt-3 flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              {t("appStore.acknowledge")}
            </label>
          </Alert>
        ) : null}
        {app.variables.length ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 font-semibold">{t("appStore.variables")}</legend>
            {app.variables.map((entry) =>
              entry.field?.options.length || entry.field?.type === "boolean" ? (
                <Select
                  key={entry.key}
                  label={localized(entry.field.label, i18n.language) || entry.key}
                  value={variables[entry.key] ?? entry.default ?? ""}
                  onChange={(value) =>
                    setVariables((previous) => ({ ...previous, [entry.key]: value }))
                  }
                  options={[
                    { value: "", label: t("appStore.choose") },
                    ...(entry.field.type === "boolean"
                      ? [
                          { value: "true", label: t("common.yes") },
                          { value: "false", label: t("common.no") },
                        ]
                      : entry.field.options),
                  ]}
                />
              ) : (
                <Field
                  key={entry.key}
                  label={
                    entry.field && localized(entry.field.label, i18n.language)
                      ? `${localized(entry.field.label, i18n.language)} (${entry.key})`
                      : entry.key
                  }
                  type={
                    entry.secret
                      ? "password"
                      : entry.field?.type === "number"
                        ? "number"
                        : entry.field?.type === "email"
                          ? "email"
                          : entry.field?.type === "url"
                            ? "url"
                            : "text"
                  }
                  autoComplete="off"
                  value={variables[entry.key] ?? (entry.generated ? "" : entry.default) ?? ""}
                  required={
                    !entry.generated &&
                    entry.required &&
                    !(
                      /^SERVICE_(URL|FQDN)_/.test(entry.key) &&
                      app.variables.some(
                        (other) =>
                          other.key ===
                          entry.key.replace(
                            /^SERVICE_(URL|FQDN)_/,
                            entry.key.startsWith("SERVICE_URL_") ? "SERVICE_FQDN_" : "SERVICE_URL_",
                          ),
                      )
                    )
                  }
                  hint={
                    entry.generated
                      ? t("appStore.generated")
                      : entry.field
                        ? localized(entry.field.hint, i18n.language)
                        : undefined
                  }
                  {...(entry.field?.type === "number"
                    ? { min: entry.field.min ?? undefined, max: entry.field.max ?? undefined }
                    : {
                        minLength:
                          entry.field?.type === "random"
                            ? undefined
                            : (entry.field?.min ?? undefined),
                        maxLength:
                          entry.field?.type === "random" ? 4096 : (entry.field?.max ?? 4096),
                      })}
                  onChange={(event) =>
                    setVariables((previous) => ({ ...previous, [entry.key]: event.target.value }))
                  }
                />
              ),
            )}
          </fieldset>
        ) : null}
        {sources.some((source) => source.dataCopyEligible) ? (
          <div className="flex flex-col gap-2">
            <Select
              label={t("appStore.dataSource")}
              value={dataFrom}
              onChange={setDataFrom}
              options={[
                { value: "", label: t("appStore.freshData") },
                ...sources
                  .filter((source) => source.dataCopyEligible)
                  .map((source) => ({
                    value: source.id,
                    label: `${localized(source.name, i18n.language)} · ${source.id.slice(0, 8)}`,
                  })),
              ]}
            />
            <p className="text-xs text-fg-subtle">{t("appStore.dataCopyHint")}</p>
          </div>
        ) : null}
        {app.ports.length ? (
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 font-semibold">{t("appStore.ports")}</legend>
            {app.ports.map((port) => (
              <Field
                key={`${port.service}:${port.index}`}
                label={t("appStore.port", port)}
                type="number"
                min={1024}
                max={65535}
                required
                value={
                  ports[`${port.service}:${port.index}`] ??
                  (port.host && port.host >= 1024 ? port.host : 8080)
                }
                onChange={(event) =>
                  setPorts((previous) => ({
                    ...previous,
                    [`${port.service}:${port.index}`]: event.target.value,
                  }))
                }
              />
            ))}
          </fieldset>
        ) : null}
        <p className="text-xs text-fg-subtle">{t("appStore.installHint")}</p>
        {error ? (
          <Alert tone="danger">
            {t("appStore.installError")}
            <ResourceError error={error} />
          </Alert>
        ) : null}
        <div className="flex justify-end gap-3">
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {permissions.includes("apps:manage") ? (
            <Button
              type="submit"
              loading={pending}
              disabled={
                !!app.blockers.length ||
                (privileged && !admin) ||
                (!!app.risks.length && !acknowledged)
              }
            >
              {t("appStore.install")}
            </Button>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}
