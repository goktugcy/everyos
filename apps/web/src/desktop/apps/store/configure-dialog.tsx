import {
  AUTOMATIC_APP_VARIABLES,
  type AppConfiguration,
  type AppJobView,
  type InstalledAppView,
} from "@everyos/shared";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { api } from "../../../lib/api.ts";
import { useSessionStore } from "../../../stores/session-store.ts";
import { LoadingBlock, ResourceError } from "../system/parts.tsx";
import { localized } from "./parts.tsx";

/**
 * Changes an installed app's settings, or moves it to the catalog's newer definition with the
 * same settings. Secrets arrive empty and stay as they are unless a new value is typed;
 * generated values (such as database passwords) are never shown or regenerated.
 */
export function ConfigureDialog({
  app,
  target,
  onClose,
  onJob,
}: {
  app: InstalledAppView;
  target: "current" | "update";
  onClose: () => void;
  onJob: (job: AppJobView) => void;
}) {
  const { t, i18n } = useTranslation();
  const admin = useSessionStore((state) => state.session?.user.role === "admin");
  const [form, setForm] = useState<AppConfiguration | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<AppConfiguration>(`/apps/${app.id}/configuration?target=${target}`, {
      signal: controller.signal,
    })
      .then((result) => {
        setForm(result);
        setValues(
          Object.fromEntries(
            result.variables.map((entry) => [entry.key, entry.value ?? entry.default ?? ""]),
          ),
        );
        setPorts(
          Object.fromEntries(
            result.fixedPorts.map((port) => [`${port.service}:${port.index}`, String(port.host)]),
          ),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setLoadError(caught);
      });
    return () => controller.abort();
  }, [app.id, target]);
  const name = localized(app.name, i18n.language);
  const privileged =
    form?.risks.some((risk) => risk !== "unpinned-image" && risk !== "default-secret") ?? false;
  const visible = (form?.variables ?? []).filter(
    (entry) => !entry.generated && !AUTOMATIC_APP_VARIABLES.some((key) => key === entry.key),
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setPending(true);
    setError(null);
    try {
      const job = await api<AppJobView>(`/apps/${app.id}/configure`, {
        method: "POST",
        body: {
          target,
          // Untouched secrets are sent empty, which keeps the stored value.
          variables: Object.fromEntries(
            visible.map((entry) => [entry.key, values[entry.key] ?? ""]),
          ),
          ports: form.ports.flatMap((port) => {
            const value = ports[`${port.service}:${port.index}`];
            return value ? [{ service: port.service, index: port.index, host: Number(value) }] : [];
          }),
          acknowledgeRisks: acknowledged,
          confirmId: app.id,
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
      title={t(
        target === "update" ? "appStore.configure.updateTitle" : "appStore.configure.title",
        {
          name,
        },
      )}
      className="w-[min(96vw,600px)]"
    >
      {!form && !loadError ? <LoadingBlock /> : null}
      <ResourceError error={loadError} />
      {form ? (
        <form
          className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1 text-sm"
          onSubmit={(event) => void submit(event)}
          data-testid="app-configure-form"
        >
          <Alert tone="info">
            {t(target === "update" ? "appStore.configure.updateHint" : "appStore.configure.hint")}
          </Alert>
          {target === "update" ? (
            <dl className="flex flex-col gap-1 text-xs">
              <dt className="font-medium">{t("appStore.images")}</dt>
              <dd className="break-all font-mono text-fg-muted">{form.images.join(", ")}</dd>
              {form.version ? (
                <>
                  <dt className="font-medium">{t("appStore.configure.newVersion")}</dt>
                  <dd className="font-mono text-fg-muted">{form.version}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          {visible.length ? (
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 font-semibold">{t("appStore.variables")}</legend>
              {visible.map((entry) => {
                const label =
                  entry.field && localized(entry.field.label, i18n.language)
                    ? `${localized(entry.field.label, i18n.language)} (${entry.key})`
                    : entry.key;
                const set = (value: string) =>
                  setValues((previous) => ({ ...previous, [entry.key]: value }));
                return entry.field?.options.length || entry.field?.type === "boolean" ? (
                  <Select
                    key={entry.key}
                    label={label}
                    value={values[entry.key] ?? ""}
                    onChange={set}
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
                    label={label}
                    type={
                      entry.secret ? "password" : entry.field?.type === "number" ? "number" : "text"
                    }
                    autoComplete="off"
                    value={values[entry.key] ?? ""}
                    required={entry.required && !entry.secret}
                    hint={
                      entry.secret && entry.hasValue
                        ? t("appStore.configure.secretKept")
                        : entry.field
                          ? localized(entry.field.hint, i18n.language)
                          : undefined
                    }
                    onChange={(event) => set(event.target.value)}
                  />
                );
              })}
              {form.variables.some((entry) => entry.generated) ? (
                <p className="text-xs text-fg-subtle">{t("appStore.configure.generatedKept")}</p>
              ) : null}
            </fieldset>
          ) : null}
          {form.ports.length ? (
            <fieldset className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-2 font-semibold">{t("appStore.ports")}</legend>
              {form.ports.map((port) => (
                <Field
                  key={`${port.service}:${port.index}`}
                  label={t("appStore.port", port)}
                  type="number"
                  min={1024}
                  max={65535}
                  value={ports[`${port.service}:${port.index}`] ?? ""}
                  placeholder={t("appStore.automaticPort")}
                  hint={t("appStore.portHint")}
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
          {form.risks.length ? (
            <Alert tone="warning" title={t("appStore.riskTitle")}>
              <ul className="list-inside list-disc">
                {form.risks.map((risk) => (
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
          {error ? <ResourceError error={error} onDismiss={() => setError(null)} /> : null}
          <div className="flex justify-end gap-3">
            <Button variant="ghost" disabled={pending} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={pending}
              disabled={(privileged && !admin) || (form.risks.length > 0 && !acknowledged)}
            >
              {t(target === "update" ? "appStore.configure.update" : "appStore.configure.apply")}
            </Button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}
