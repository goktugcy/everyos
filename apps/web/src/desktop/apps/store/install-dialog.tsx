import type { AppJobView, CatalogAppView } from "@otuken/shared";
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

export function InstallDialog({
  app,
  onClose,
  onJob,
}: {
  app: CatalogAppView;
  onClose: () => void;
  onJob: (job: AppJobView) => void;
}) {
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const admin = useSessionStore((state) => state.session?.user.role === "admin");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const privileged = app.risks.some(
    (risk) => risk !== "unpinned-image" && risk !== "default-secret",
  );
  const submit = async () => {
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
            {app.variables.map((entry) => (
              <Field
                key={entry.key}
                label={entry.key}
                type={entry.secret ? "password" : "text"}
                autoComplete="off"
                value={variables[entry.key] ?? (entry.generated ? "" : entry.default) ?? ""}
                required={!entry.generated && entry.required}
                hint={entry.generated ? t("appStore.generated") : undefined}
                onChange={(event) =>
                  setVariables((previous) => ({ ...previous, [entry.key]: event.target.value }))
                }
              />
            ))}
          </fieldset>
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
