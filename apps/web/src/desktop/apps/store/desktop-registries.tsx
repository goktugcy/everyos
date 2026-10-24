import type { DesktopAppRegistryView } from "@everyos/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { api } from "../../../lib/api.ts";
import { formatRelative } from "../../../lib/format.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { ResourceError } from "../system/parts.tsx";

/** One desktop app source, with its key fingerprint and sync state. */
export function RegistryCard({
  registry,
  onChanged,
}: {
  registry: DesktopAppRegistryView;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };
  const builtIn = registry.kind === "official" || registry.id === "community";
  return (
    <article
      className="glass-inset flex flex-col gap-2 rounded-everyos-md p-4"
      data-testid="desktop-app-registry"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-fg">
          {registry.name}
          <span className="ml-2 rounded-full bg-hover/12 px-2 py-0.5 text-[0.68rem] font-medium text-fg-muted">
            {t(`desktopApps.store.sources.${registry.kind}`)}
          </span>
        </h3>
        <span className="text-xs text-fg-subtle">
          {registry.syncedAt
            ? t("desktopApps.registries.synced", {
                time: formatRelative(registry.syncedAt, i18n.language),
              })
            : t("desktopApps.registries.never")}
        </span>
      </div>
      <p className="break-all text-xs text-fg-muted">{registry.url}</p>
      <p className="break-all font-mono text-[0.68rem] text-fg-subtle">{registry.fingerprint}</p>
      <p className="text-xs text-fg-muted">
        {t("desktopApps.registries.apps", { count: registry.appCount })}
      </p>
      {registry.lastError ? (
        <p role="alert" className="text-xs text-danger">
          {t("desktopApps.registries.failed", { reason: registry.lastError })}
        </p>
      ) : null}
      <ResourceError error={error} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={pending || !registry.enabled}
          onClick={() =>
            void run(() =>
              api(`/desktop-apps/registries/${registry.id}/sync`, { method: "POST", body: {} }),
            )
          }
        >
          {t("desktopApps.registries.sync")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            void run(() =>
              api(`/desktop-apps/registries/${registry.id}`, {
                method: "PATCH",
                body: { enabled: !registry.enabled },
              }),
            )
          }
        >
          {registry.enabled ? t("desktopApps.store.disable") : t("desktopApps.store.enable")}
        </Button>
        {!builtIn ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              void (async () => {
                if (
                  await requestConfirm({
                    title: t("desktopApps.registries.removeTitle", { name: registry.name }),
                    body: t("desktopApps.registries.removeBody"),
                    confirmLabel: t("desktopApps.registries.remove"),
                    danger: true,
                  })
                )
                  await run(() =>
                    api(`/desktop-apps/registries/${registry.id}`, { method: "DELETE", body: {} }),
                  );
              })()
            }
          >
            {t("desktopApps.registries.remove")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/** Adds a community or private source after the administrator compared its key fingerprint. */
export function AddRegistryDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"community" | "private">("private");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [token, setToken] = useState("");
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const created = await api<DesktopAppRegistryView>("/desktop-apps/registries", {
        method: "POST",
        body: {
          kind,
          name: name.trim(),
          url: url.trim(),
          publicKey: publicKey.trim(),
          fingerprint: fingerprint.trim(),
          ...(token.trim() ? { token: token.trim() } : {}),
          allowPrivate,
        },
      });
      await api(`/desktop-apps/registries/${created.id}/sync`, { method: "POST", body: {} }).catch(
        () => undefined,
      );
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
      onOpenChange={(open) => !open && onClose()}
      title={t("desktopApps.registries.add")}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Select
          label={t("desktopApps.registries.kind")}
          value={kind}
          onChange={(value) => setKind(value)}
          options={[
            { value: "private", label: t("desktopApps.store.sources.private") },
            { value: "community", label: t("desktopApps.store.sources.community") },
          ]}
        />
        <Field
          label={t("desktopApps.registries.name")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <Field
          label={t("desktopApps.registries.url")}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
        />
        <label className="flex flex-col gap-1 text-sm text-fg">
          {t("desktopApps.registries.publicKey")}
          <textarea
            value={publicKey}
            onChange={(event) => setPublicKey(event.target.value)}
            rows={4}
            required
            spellCheck={false}
            className="glass-inset rounded-everyos-md p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
        <Field
          label={t("desktopApps.registries.fingerprint")}
          hint={t("desktopApps.registries.fingerprintHint")}
          value={fingerprint}
          onChange={(event) => setFingerprint(event.target.value)}
          required
        />
        {kind === "private" ? (
          <Field
            label={t("desktopApps.registries.token")}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
          />
        ) : null}
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={allowPrivate}
            onChange={(event) => setAllowPrivate(event.target.checked)}
            className="size-4 accent-[rgb(var(--everyos-accent))]"
          />
          {t("desktopApps.registries.allowPrivate")}
        </label>
        <ResourceError error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={pending}>
            {t("desktopApps.registries.add")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
