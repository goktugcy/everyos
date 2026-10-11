import type { StorageUsage, WidgetConfigValue, WidgetInstance, WidgetSize } from "@everyos/shared";
import {
  getWidget,
  normalizeConfig,
  sizesFor,
  type WidgetConfigField,
  type WidgetManifest,
} from "@everyos/widget-sdk";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Select } from "../../components/ui/select.tsx";
import { Slider } from "../../components/ui/slider.tsx";
import { formatPercent } from "../../lib/format.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { localized } from "../apps/store/parts.tsx";
import { Toggle } from "../menubar/quick-settings.tsx";
import { desktop } from "../state/controller.ts";
import { usePreferences } from "../state/preferences-store.ts";
import { wm } from "../state/window-store.ts";
import { widgetActions } from "./actions.ts";
import { useIntegrations } from "./integrations.ts";
import { widgetTitle } from "./labels.ts";
import type { DockerData } from "./renderers/docker.tsx";
import { useTopic } from "./topics.ts";
import { useWidgetUi, widgetUi } from "./ui-store.ts";

type Config = Record<string, WidgetConfigValue>;

const selectClass =
  "glass-inset h-10 w-full appearance-none rounded-everyos-md px-3 text-sm text-fg outline-none focus-visible:border-accent/70 focus-visible:shadow-[0_0_0_3px_rgb(var(--everyos-accent)/0.25)] [&_option]:bg-[rgb(var(--everyos-surface))] [&_option]:text-fg";

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  );
}

function ManageLink() {
  const { t } = useTranslation();
  const canManage = usePermissions().includes("apps:manage");
  if (!canManage) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      className="self-start"
      onClick={() => {
        widgetUi.configure(null);
        desktop.openSettings("widgets");
      }}
    >
      {t("widgets.configure.manageIntegrations")}
    </Button>
  );
}

function DockerTargetField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const state = useTopic<DockerData>("data.docker");
  const data = state.status === "ok" ? state.data : null;
  const projects = [
    ...new Set(
      (data?.containers ?? []).map((c) => c.project).filter((p): p is string => Boolean(p)),
    ),
  ].sort();
  const known = new Set([
    ...(data?.apps ?? []).map((app) => `app:${app.id}`),
    ...projects.map((project) => `project:${project}`),
    ...(data?.containers ?? []).map((container) => `container:${container.name}`),
  ]);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[0.8rem] font-medium text-fg-muted">
        {label}
      </label>
      <select
        id={id}
        className={selectClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("widgets.configure.choose")}</option>
        {data && data.apps.length > 0 ? (
          <optgroup label={t("widgets.configure.targetGroups.apps")}>
            {data.apps.map((app) => (
              <option key={app.id} value={`app:${app.id}`}>
                {localized(app.name, i18n.language) || app.project}
              </option>
            ))}
          </optgroup>
        ) : null}
        {projects.length > 0 ? (
          <optgroup label={t("widgets.configure.targetGroups.projects")}>
            {projects.map((project) => (
              <option key={project} value={`project:${project}`}>
                {project}
              </option>
            ))}
          </optgroup>
        ) : null}
        {data && data.containers.length > 0 ? (
          <optgroup label={t("widgets.configure.targetGroups.containers")}>
            {[...data.containers]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((container) => (
                <option key={container.id} value={`container:${container.name}`}>
                  {container.name}
                </option>
              ))}
          </optgroup>
        ) : null}
        {/* Keep a target that is currently missing visible instead of silently clearing it. */}
        {value && !known.has(value) ? <option value={value}>{value}</option> : null}
      </select>
    </div>
  );
}

function MountField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const state = useTopic<StorageUsage>("data.storage");
  const mounts = state.status === "ok" ? state.data.mounts.map((m) => m.mountpoint) : [];
  const options = [...new Set([value, ...mounts])].map((mount) => ({ value: mount, label: mount }));
  return <Select label={label} value={value} options={options} onChange={onChange} />;
}

function ConfigField({
  field,
  config,
  setValue,
}: {
  field: WidgetConfigField;
  config: Config;
  setValue: (key: string, value: WidgetConfigValue) => void;
}) {
  const { t } = useTranslation();
  const { integrations } = useIntegrations();
  const label = t(`widgets.configure.fields.${field.key as "chart"}`);
  const value = config[field.key];
  switch (field.type) {
    case "boolean":
      return (
        <FieldRow label={label}>
          <Toggle
            label={label}
            checked={value === true}
            onCheckedChange={(checked) => setValue(field.key, checked)}
          />
        </FieldRow>
      );
    case "select":
      return (
        <Select
          label={label}
          value={typeof value === "string" ? value : field.default}
          options={field.options.map((option) => ({
            value: option,
            label: t(`widgets.configure.values.${option as "cpu"}`),
          }))}
          onChange={(next) => setValue(field.key, next)}
        />
      );
    case "number":
      return (
        <Slider
          label={label}
          value={typeof value === "number" ? value : field.default}
          min={field.min}
          max={field.max}
          step={1}
          onChange={(next) => setValue(field.key, next)}
        />
      );
    case "mount":
      return (
        <MountField
          label={label}
          value={typeof value === "string" ? value : field.default}
          onChange={(next) => setValue(field.key, next)}
        />
      );
    case "dockerTarget":
      return (
        <DockerTargetField
          label={label}
          value={typeof value === "string" ? value : ""}
          onChange={(next) => setValue(field.key, next)}
        />
      );
    case "integration": {
      const options = integrations.filter((i) => i.adapter === field.adapter);
      if (options.length === 0)
        return (
          <div className="flex flex-col gap-2">
            <span className="text-[0.8rem] font-medium text-fg-muted">{label}</span>
            <p className="text-sm text-fg-muted">{t("widgets.configure.noIntegrations")}</p>
            <ManageLink />
          </div>
        );
      return (
        <Select
          label={label}
          value={typeof value === "string" ? value : ""}
          options={[
            { value: "", label: t("widgets.configure.choose") },
            ...options.map((i) => ({
              value: i.id,
              label: i.appMissing ? `${i.name} (${t("widgets.integrations.appMissing")})` : i.name,
            })),
          ]}
          onChange={(next) => {
            setValue(field.key, next);
            // Entities belong to one connection.
            if (config.entities !== undefined) setValue("entities", []);
          }}
        />
      );
    }
    case "entities": {
      const integration = integrations.find((i) => i.id === config.integration);
      const available =
        (field.control ? integration?.options.controlEntities : integration?.options.entities) ??
        [];
      const selected = Array.isArray(value) ? value : [];
      return (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-[0.8rem] font-medium text-fg-muted">{label}</legend>
          {!integration ? null : available.length === 0 ? (
            <>
              <p className="text-sm text-fg-muted">{t("widgets.configure.noEntities")}</p>
              <ManageLink />
            </>
          ) : (
            <>
              <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                {available.map((entity) => {
                  const checked = selected.includes(entity);
                  return (
                    <li key={entity}>
                      <label className="flex items-center gap-2 rounded-everyos-sm px-1 py-1 text-sm hover:bg-hover/6">
                        <input
                          type="checkbox"
                          className="size-4 accent-[rgb(var(--everyos-accent))]"
                          checked={checked}
                          disabled={!checked && selected.length >= field.maxItems}
                          onChange={(event) =>
                            setValue(
                              field.key,
                              event.target.checked
                                ? [...selected, entity]
                                : selected.filter((e) => e !== entity),
                            )
                          }
                        />
                        <span className="font-mono text-xs">{entity}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs text-fg-subtle">
                {t("widgets.configure.maxItems", { count: field.maxItems })}
              </p>
            </>
          )}
        </fieldset>
      );
    }
  }
}

function ConfigureForm({
  instance,
  manifest,
}: {
  instance: WidgetInstance;
  manifest: WidgetManifest;
}) {
  const { t, i18n } = useTranslation();
  const [config, setConfig] = useState<Config>(() => ({ ...instance.config }));
  const [size, setSize] = useState<WidgetSize>(instance.size);
  const [opacity, setOpacity] = useState(instance.opacity);
  const [locked, setLocked] = useState(instance.locked);
  const [allDesktops, setAllDesktops] = useState(instance.desktopId === null);
  const [error, setError] = useState<string | null>(null);
  const sizes = sizesFor(manifest, instance.placement).filter(
    (s) => s !== "custom" || instance.size === "custom",
  );
  const isDesktop = instance.placement === "desktop";

  const save = () => {
    if (size !== instance.size) {
      // Size changes are checked against free desktop space first.
      if (instance.locked) widgetActions.update(instance.id, { locked: false });
      if (!widgetActions.resize(instance.id, size, size === "custom" ? instance.custom : null)) {
        if (instance.locked) widgetActions.update(instance.id, { locked: true });
        setError(t("widgets.configure.noSpace"));
        return;
      }
    }
    widgetActions.update(instance.id, {
      config: normalizeConfig(manifest, config),
      opacity,
      locked,
      ...(isDesktop
        ? { desktopId: allDesktops ? null : (instance.desktopId ?? wm().activeDesktopId) }
        : {}),
    });
    widgetUi.configure(null);
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <section className="flex flex-col gap-4" aria-label={t("widgets.configure.general")}>
        {manifest.config.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("widgets.configure.noOptions")}</p>
        ) : (
          manifest.config.map((field) => (
            <ConfigField
              key={field.key}
              field={field}
              config={config}
              setValue={(key, value) => setConfig((current) => ({ ...current, [key]: value }))}
            />
          ))
        )}
      </section>
      <section
        className="flex flex-col gap-4 border-t border-line pt-4"
        aria-label={t("widgets.configure.appearance")}
      >
        <h3 className="text-sm font-semibold">{t("widgets.configure.appearance")}</h3>
        {sizes.length > 1 ? (
          <Select
            label={t("widgets.configure.size")}
            value={size}
            options={sizes.map((option) => ({
              value: option,
              label: t(`widgets.sizes.${option}`),
            }))}
            onChange={setSize}
          />
        ) : null}
        {instance.placement !== "menubar" ? (
          <Slider
            label={t("widgets.configure.opacity")}
            value={Math.round(opacity * 100)}
            min={30}
            max={100}
            step={5}
            format={(value) => formatPercent(value, i18n.language)}
            onChange={(value) => setOpacity(value / 100)}
          />
        ) : null}
        {isDesktop ? (
          <>
            <FieldRow label={t("widgets.configure.locked")}>
              <Toggle
                label={t("widgets.configure.locked")}
                checked={locked}
                onCheckedChange={setLocked}
              />
            </FieldRow>
            <FieldRow label={t("widgets.configure.allDesktops")}>
              <Toggle
                label={t("widgets.configure.allDesktops")}
                checked={allDesktops}
                onCheckedChange={setAllDesktops}
              />
            </FieldRow>
          </>
        ) : null}
      </section>
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => widgetUi.configure(null)}>
          {t("common.cancel")}
        </Button>
        <Button type="submit">{t("common.save")}</Button>
      </div>
    </form>
  );
}

/** Configuration dialog of the widget being configured (generated from its manifest). */
export function WidgetConfigureDialog() {
  const { t } = useTranslation();
  const id = useWidgetUi((state) => state.configuring);
  const instance = usePreferences((state) => state.widgets.instances.find((i) => i.id === id));
  const manifest = instance ? getWidget(instance.widgetId) : undefined;
  return (
    <Dialog
      open={Boolean(instance && manifest)}
      onOpenChange={(open) => !open && widgetUi.configure(null)}
      title={
        instance ? t("widgets.configure.title", { name: widgetTitle(t, instance.widgetId) }) : ""
      }
    >
      {instance && manifest ? (
        <ConfigureForm key={instance.id} instance={instance} manifest={manifest} />
      ) : null}
    </Dialog>
  );
}
