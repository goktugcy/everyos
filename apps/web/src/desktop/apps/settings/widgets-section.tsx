import {
  HOME_ASSISTANT_CONTROL_DOMAINS,
  INTEGRATION_ADAPTERS,
  type InstalledAppView,
  type IntegrationAdapter,
  type IntegrationAudience,
  type IntegrationView,
  type TopicUnavailableReason,
} from "@everyos/shared";
import { CheckCircle2, KeyRound, Pencil, Plug, Plus, TriangleAlert, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field, PasswordField, inputClassName } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { usePermissions, useSessionStore } from "../../../stores/session-store.ts";
import { Toggle } from "../../menubar/quick-settings.tsx";
import { requestConfirm } from "../../menus/confirm.tsx";
import { usePreferences } from "../../state/preferences-store.ts";
import { widgetActions } from "../../widgets/actions.ts";
import { ADAPTER_FORMS, useIntegrations } from "../../widgets/integrations.ts";
import { widgetUi } from "../../widgets/ui-store.ts";
import { useAppHost } from "../app-context.ts";
import { localized } from "../store/parts.tsx";
import { SettingRow, SettingsGroup } from "./group.tsx";

/** Values that pre-fill a new connection (e.g. from an installed app's widget offer). */
export interface IntegrationDraft {
  adapter: IntegrationAdapter;
  appId?: string;
  name?: string;
  baseUrl?: string;
}

const ENTITY_LINE = /^[a-z_]+\.[a-z0-9_]{1,100}$/;

function parseEntities(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((line) => line.trim())
        .filter((line) => ENTITY_LINE.test(line)),
    ),
  ];
}

function LayoutGroup() {
  const { t } = useTranslation();
  const permissions = useSessionStore((state) => state.session?.permissions ?? []);
  const widgets = usePreferences((state) => state.widgets);
  return (
    <SettingsGroup title={t("widgets.settings.title")}>
      <SettingRow label={t("widgets.settings.sidebar")} hint={t("widgets.settings.sidebarHint")}>
        <Toggle
          label={t("widgets.settings.sidebar")}
          checked={widgets.sidebar.open}
          onCheckedChange={(open) => widgetActions.setSidebar(open)}
        />
      </SettingRow>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-fg-muted">
          {t("widgets.settings.placed", { count: widgets.instances.length })}
        </span>
        <Button size="sm" variant="secondary" onClick={() => widgetUi.openGallery("desktop")}>
          <Plus className="size-4" aria-hidden />
          {t("widgets.settings.gallery")}
        </Button>
      </div>
      <div className="flex flex-col items-start gap-1.5 border-t border-line pt-4">
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void requestConfirm({
              title: t("widgets.settings.restoreConfirm.title"),
              body: t("widgets.settings.restoreConfirm.body"),
              confirmLabel: t("widgets.settings.restoreConfirm.confirm"),
              danger: true,
            }).then((ok) => ok && widgetActions.restoreDefaults(permissions))
          }
        >
          {t("widgets.settings.restore")}
        </Button>
        <p className="text-xs text-fg-muted">{t("widgets.settings.restoreHint")}</p>
      </div>
    </SettingsGroup>
  );
}

type TestResult =
  | { status: "ok" }
  | { status: "unavailable"; reason: TopicUnavailableReason }
  | { status: "error"; code: string };

function IntegrationItem({
  integration,
  canManage,
  onEdit,
  onChanged,
}: {
  integration: IntegrationView;
  canManage: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const outcome = await api<TestResult>(`/integrations/${integration.id}/test`, {
        method: "POST",
      });
      setOk(outcome.status === "ok");
      setResult(
        outcome.status === "ok"
          ? t("widgets.integrations.testOk")
          : t("widgets.integrations.testFailed", {
              reason:
                outcome.status === "unavailable"
                  ? t(`widgets.reasons.${outcome.reason}`)
                  : outcome.code,
            }),
      );
    } catch (cause) {
      setOk(false);
      setResult(errorMessage(t, cause));
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    const confirmed = await requestConfirm({
      title: t("widgets.integrations.deleteConfirm.title"),
      body: t("widgets.integrations.deleteConfirm.body", { name: integration.name }),
      confirmLabel: t("widgets.integrations.deleteConfirm.confirm"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/integrations/${integration.id}`, { method: "DELETE" });
      onChanged();
    } catch (cause) {
      setError(errorMessage(t, cause));
    }
  };

  const target = ADAPTER_FORMS[integration.adapter].baseUrl
    ? integration.baseUrl
    : [integration.options.container, integration.options.database].filter(Boolean).join(" · ");
  return (
    <li
      className="flex flex-col gap-2 rounded-everyos-md bg-hover/5 p-3"
      data-testid="integration-item"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-semibold">{integration.name}</span>
          <span className="text-xs text-fg-muted">
            {t(`widgets.integrations.adapters.${integration.adapter}`)}
            {target ? <span className="font-mono"> · {target}</span> : null}
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
            <span>{t(`widgets.integrations.audiences.${integration.audience}`)}</span>
            {ADAPTER_FORMS[integration.adapter].secret ? (
              <span className="flex items-center gap-1">
                <KeyRound className="size-3" aria-hidden />
                {integration.hasCredentials
                  ? t("widgets.integrations.hasCredentials")
                  : t("widgets.integrations.noCredentials")}
              </span>
            ) : null}
            {integration.appMissing ? (
              <span className="flex items-center gap-1 text-warning">
                <TriangleAlert className="size-3" aria-hidden />
                {t("widgets.integrations.appMissing")}
              </span>
            ) : null}
          </span>
        </div>
        {canManage ? (
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" loading={testing} onClick={() => void test()}>
              {t("widgets.integrations.test")}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("widgets.integrations.edit")}
              title={t("widgets.integrations.edit")}
              onClick={onEdit}
            >
              <Pencil className="size-4" aria-hidden />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("common.delete")}
              title={t("common.delete")}
              onClick={() => void remove()}
            >
              <Trash2 className="size-4 text-danger" aria-hidden />
            </Button>
          </div>
        ) : null}
      </div>
      {result ? (
        <p
          className={cn("flex items-center gap-1.5 text-xs", ok ? "text-success" : "text-danger")}
          role="status"
        >
          {ok ? (
            <CheckCircle2 className="size-3.5" aria-hidden />
          ) : (
            <TriangleAlert className="size-3.5" aria-hidden />
          )}
          {result}
        </p>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </li>
  );
}

export function IntegrationDialog({
  open,
  onClose,
  existing,
  draft,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  existing: IntegrationView | null;
  draft: IntegrationDraft | null;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={existing ? t("widgets.integrations.edit") : t("widgets.integrations.add")}
    >
      {open ? (
        <IntegrationForm existing={existing} draft={draft} onClose={onClose} onSaved={onSaved} />
      ) : null}
    </Dialog>
  );
}

function IntegrationForm({
  existing,
  draft,
  onClose,
  onSaved,
}: {
  existing: IntegrationView | null;
  draft: IntegrationDraft | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const apps = useApiResource<{ apps: InstalledAppView[] }>("/apps", null);
  const [adapter, setAdapter] = useState<IntegrationAdapter>(
    existing?.adapter ?? draft?.adapter ?? "jellyfin",
  );
  const [name, setName] = useState(existing?.name ?? draft?.name ?? "");
  const [appId, setAppId] = useState(existing?.appId ?? draft?.appId ?? "");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? draft?.baseUrl ?? "");
  const [secret, setSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [username, setUsername] = useState("");
  const [audience, setAudience] = useState<IntegrationAudience>(existing?.audience ?? "managers");
  const [entities, setEntities] = useState((existing?.options.entities ?? []).join("\n"));
  const [controlEntities, setControlEntities] = useState(
    (existing?.options.controlEntities ?? []).join("\n"),
  );
  const [entityScope, setEntityScope] = useState<"selected" | "all">(
    existing ? (existing.options.entityScope ?? "selected") : "all",
  );
  const [controlScope, setControlScope] = useState<"selected" | "all">(
    existing ? (existing.options.controlScope ?? "selected") : "all",
  );
  const [container, setContainer] = useState(existing?.options.container ?? "");
  const [dbUser, setDbUser] = useState(existing?.options.user ?? "postgres");
  const [database, setDatabase] = useState(existing?.options.database ?? "postgres");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = ADAPTER_FORMS[adapter];

  const save = async () => {
    setSaving(true);
    setError(null);
    const options =
      adapter === "homeassistant"
        ? {
            entityScope,
            controlScope,
            entities: parseEntities(entities),
            controlEntities: parseEntities(controlEntities).filter((e) =>
              (HOME_ASSISTANT_CONTROL_DOMAINS as readonly string[]).includes(e.split(".")[0]!),
            ),
          }
        : adapter === "postgresql"
          ? { container: container.trim(), user: dbUser.trim(), database: database.trim() }
          : {};
    const body = {
      name: name.trim() || t(`widgets.integrations.adapters.${adapter}`),
      appId: appId || null,
      baseUrl: form.baseUrl ? baseUrl.trim().replace(/\/+$/, "") || null : null,
      audience,
      options,
      ...(form.secret && secret ? { secret } : {}),
      ...(form.username && username.trim() ? { username: username.trim() } : {}),
      ...(existing && clearSecret && !secret ? { clearSecret: true } : {}),
    };
    try {
      if (existing) await api(`/integrations/${existing.id}`, { method: "PATCH", body });
      else await api("/integrations", { method: "POST", body: { adapter, ...body } });
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(t, cause));
    } finally {
      setSaving(false);
    }
  };

  const linkable = (apps.data?.apps ?? []).filter(
    (app) => app.widgetAdapters.includes(adapter) || app.id === appId,
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {!existing ? (
        <Select
          label={t("widgets.integrations.adapter")}
          value={adapter}
          options={INTEGRATION_ADAPTERS.map((value) => ({
            value,
            label: t(`widgets.integrations.adapters.${value}`),
          }))}
          onChange={setAdapter}
        />
      ) : null}
      <Field
        label={t("widgets.integrations.name")}
        value={name}
        maxLength={64}
        placeholder={t(`widgets.integrations.adapters.${adapter}`)}
        onChange={(event) => setName(event.target.value)}
      />
      <Select
        label={t("widgets.integrations.app")}
        value={appId}
        options={[
          { value: "", label: t("widgets.integrations.appNone") },
          ...linkable.map((app) => ({
            value: app.id,
            label: localized(app.name, i18n.language) || app.project,
          })),
        ]}
        onChange={setAppId}
      />
      {form.baseUrl ? (
        <Field
          label={t("widgets.integrations.baseUrl")}
          hint={t("widgets.integrations.baseUrlHint")}
          value={baseUrl}
          required
          inputMode="url"
          placeholder={
            form.defaultPort ? `http://127.0.0.1:${form.defaultPort}` : "https://cloud.example.com"
          }
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      ) : null}
      {form.secret ? (
        <>
          <PasswordField
            label={t(`widgets.integrations.secretLabels.${adapter}`)}
            hint={
              existing?.hasCredentials
                ? t("widgets.integrations.secretKeep")
                : t(`widgets.integrations.secretHints.${adapter}`)
            }
            value={secret}
            autoComplete="off"
            required={!existing?.hasCredentials}
            onChange={(event) => setSecret(event.target.value)}
          />
          {existing?.hasCredentials ? (
            <SettingRow label={t("widgets.integrations.clearSecret")}>
              <Toggle
                label={t("widgets.integrations.clearSecret")}
                checked={clearSecret}
                onCheckedChange={setClearSecret}
              />
            </SettingRow>
          ) : null}
        </>
      ) : null}
      {form.username ? (
        <Field
          label={t("widgets.integrations.username")}
          hint={t("widgets.integrations.usernameHint")}
          value={username}
          autoComplete="off"
          onChange={(event) => setUsername(event.target.value)}
        />
      ) : null}
      {adapter === "homeassistant" ? (
        <>
          <Select
            label={t("homeAssistant.entityScope")}
            value={entityScope}
            onChange={setEntityScope}
            options={[
              { value: "all", label: t("homeAssistant.all") },
              { value: "selected", label: t("homeAssistant.selected") },
            ]}
          />
          {entityScope === "selected" ? (
            <EntityList
              label={t("widgets.integrations.entities")}
              hint={t("widgets.integrations.entitiesHint")}
              value={entities}
              onChange={setEntities}
            />
          ) : null}
          <Select
            label={t("homeAssistant.controlScope")}
            value={controlScope}
            onChange={setControlScope}
            options={[
              { value: "all", label: t("homeAssistant.all") },
              { value: "selected", label: t("homeAssistant.selected") },
            ]}
          />
          {controlScope === "selected" ? (
            <EntityList
              label={t("widgets.integrations.controlEntities")}
              hint={t("widgets.integrations.controlEntitiesHint")}
              value={controlEntities}
              onChange={setControlEntities}
            />
          ) : null}
          {entityScope === "all" || controlScope === "all" ? (
            <p className="text-xs text-fg-muted">{t("homeAssistant.allHelp")}</p>
          ) : null}
        </>
      ) : null}
      {adapter === "postgresql" ? (
        <>
          <Field
            label={t("widgets.integrations.container")}
            value={container}
            required
            pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}"
            onChange={(event) => setContainer(event.target.value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t("widgets.integrations.dbUser")}
              value={dbUser}
              required
              pattern="[A-Za-z_][A-Za-z0-9_]{0,62}"
              onChange={(event) => setDbUser(event.target.value)}
            />
            <Field
              label={t("widgets.integrations.database")}
              value={database}
              required
              pattern="[A-Za-z_][A-Za-z0-9_]{0,62}"
              onChange={(event) => setDatabase(event.target.value)}
            />
          </div>
          <p className="text-xs text-fg-muted">{t("widgets.integrations.postgresHint")}</p>
        </>
      ) : null}
      <Select
        label={t("widgets.integrations.audience")}
        value={audience}
        options={(["managers", "everyone"] as const).map((value) => ({
          value,
          label: t(`widgets.integrations.audiences.${value}`),
        }))}
        onChange={setAudience}
      />
      <p className="-mt-2 text-xs text-fg-muted">{t("widgets.integrations.audienceHint")}</p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={saving}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}

function EntityList({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[0.8rem] font-medium text-fg-muted">{label}</span>
      <textarea
        value={value}
        rows={4}
        spellCheck={false}
        className={cn(inputClassName, "h-auto py-2 font-mono text-xs")}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="text-xs text-fg-muted">{hint}</span>
    </label>
  );
}

function IntegrationsGroup() {
  const { t } = useTranslation();
  const host = useAppHost();
  const canManage = usePermissions().includes("apps:manage");
  const { integrations, loading, reload } = useIntegrations();
  const [editing, setEditing] = useState<{
    existing: IntegrationView | null;
    draft: IntegrationDraft | null;
  } | null>(null);

  // "Add connection" from the gallery or an app's widget offer opens the form pre-filled.
  const appState = host.appState;
  const state = useMemo(() => (appState ?? {}) as Record<string, unknown>, [appState]);
  const requested =
    canManage &&
    typeof state.newAdapter === "string" &&
    (INTEGRATION_ADAPTERS as readonly string[]).includes(state.newAdapter)
      ? (state.newAdapter as IntegrationAdapter)
      : null;
  const [handled, setHandled] = useState<unknown>(null);
  if (requested && state !== handled) {
    setHandled(state);
    const draft = (state.draft ?? {}) as Partial<IntegrationDraft>;
    setEditing({ existing: null, draft: { ...draft, adapter: requested } });
  }
  // The request is consumed so a reload does not open the form again.
  useEffect(() => {
    if (!requested) return;
    const { newAdapter: _adapter, draft: _draft, ...rest } = state;
    host.setAppState(rest);
  }, [requested, state, host]);

  return (
    <SettingsGroup
      title={t("widgets.integrations.title")}
      description={t("widgets.integrations.description")}
    >
      {!canManage ? (
        <p className="text-xs text-fg-muted">{t("widgets.integrations.readOnly")}</p>
      ) : null}
      {!loading && integrations.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Plug className="size-4" aria-hidden />
          {t("widgets.integrations.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {integrations.map((integration) => (
            <IntegrationItem
              key={integration.id}
              integration={integration}
              canManage={canManage}
              onEdit={() => setEditing({ existing: integration, draft: null })}
              onChanged={reload}
            />
          ))}
        </ul>
      )}
      {canManage ? (
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          onClick={() => setEditing({ existing: null, draft: null })}
        >
          <Plus className="size-4" aria-hidden />
          {t("widgets.integrations.add")}
        </Button>
      ) : null}
      <IntegrationDialog
        open={editing !== null}
        existing={editing?.existing ?? null}
        draft={editing?.draft ?? null}
        onClose={() => setEditing(null)}
        onSaved={reload}
      />
    </SettingsGroup>
  );
}

export default function WidgetsSection() {
  const canSeeApps = usePermissions().includes("apps:read");
  return (
    <>
      <LayoutGroup />
      {canSeeApps ? <IntegrationsGroup /> : null}
    </>
  );
}
