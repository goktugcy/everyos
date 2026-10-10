import { CATALOG_FORMATS, type CatalogFormat, type CatalogView } from "@otuken/shared";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { api } from "../../../lib/api.ts";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { formatDateTime } from "../../../lib/format.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { ResourceError } from "../system/parts.tsx";
import { operationReason } from "./parts.tsx";

export function AddCatalog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<CatalogFormat>("auto");
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await api("/catalogs", { method: "POST", body: { name, url, format, allowPrivate } });
      onChanged();
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
      title={t("appStore.addCatalog")}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4"
      >
        <Field
          label={t("appStore.name")}
          value={name}
          required
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
        <Field
          label={t("appStore.sourceUrl")}
          type="url"
          value={url}
          required
          onChange={(event) => setUrl(event.target.value)}
        />
        <Select
          label={t("appStore.format")}
          value={format}
          options={CATALOG_FORMATS.map((value) => ({
            value,
            label: t(`appStore.formats.${value}`),
          }))}
          onChange={setFormat}
        />
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={allowPrivate}
            onChange={(event) => setAllowPrivate(event.target.checked)}
          />
          {t("appStore.privateAccess")}
        </label>
        <p className="text-xs text-fg-subtle">{t("appStore.privateHint")}</p>
        <ResourceError error={error} />
        <div className="flex justify-end gap-3">
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={pending}>
            {t("appStore.addCatalog")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function CatalogCard({
  catalog,
  onChanged,
}: {
  catalog: CatalogView;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mutate = async (action: "sync" | "toggle" | "remove") => {
    if (
      action === "remove" &&
      !(await requestConfirm({
        title: t("appStore.removeCatalog"),
        body: t("appStore.removeCatalogBody"),
        confirmLabel: t("appStore.removeCatalog"),
      }))
    )
      return;
    setPending(true);
    setError(null);
    try {
      await api(`/catalogs/${catalog.id}${action === "sync" ? "/sync" : ""}`, {
        method: action === "sync" ? "POST" : action === "remove" ? "DELETE" : "PATCH",
        body: action === "toggle" ? { enabled: !catalog.enabled } : {},
      });
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
      onChanged();
    }
  };
  return (
    <article className="glass-inset flex flex-col gap-3 rounded-otk-md p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{catalog.name}</h3>
        <span className="text-xs text-fg-muted">
          {t("appStore.count", { count: catalog.appCount })}
        </span>
      </div>
      <p className="break-all font-mono text-xs text-fg-muted">{catalog.url}</p>
      <p className="text-xs text-fg-subtle">
        {catalog.syncedAt
          ? t("appStore.synced", { date: formatDateTime(catalog.syncedAt, i18n.language) })
          : t("appStore.neverSynced")}
      </p>
      {catalog.lastError ? (
        <Alert tone="warning">
          {t("appStore.syncFailed")} <code>{catalog.lastError}</code>
        </Alert>
      ) : null}
      {catalog.skipped.length ? (
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer">
            {t("appStore.skipped", { count: catalog.skipped.length })}
          </summary>
          <ul className="mt-2 max-h-40 overflow-y-auto font-mono">
            {catalog.skipped.map((entry, index) => (
              <li key={index} className="break-all">
                {entry.path}: {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <ResourceError error={error} />
      {operationReason(error) ? (
        <p className="text-xs text-danger">
          {t("appStore.failed", { reason: operationReason(error) })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={pending || !catalog.enabled}
          onClick={() => void mutate("sync")}
        >
          <RefreshCw className="size-4" aria-hidden />
          {t("appStore.sync")}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => void mutate("toggle")}>
          {t(catalog.enabled ? "appStore.disable" : "appStore.enable")}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => void mutate("remove")}>
          {t("appStore.removeCatalog")}
        </Button>
      </div>
    </article>
  );
}
