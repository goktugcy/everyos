import type { SystemInfo, WidgetPlacement, WidgetSize } from "@everyos/shared";
import {
  BUILT_IN_WIDGETS,
  missingConfig,
  sizesFor,
  supportsPlacement,
  widgetAvailability,
  type WidgetCategory,
  type WidgetManifest,
} from "@everyos/widget-sdk";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { useApiResource } from "../../features/system/use-api-resource.ts";
import { cn } from "../../lib/cn.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { desktop } from "../state/controller.ts";
import { widgetActions } from "./actions.ts";
import { useIntegrations } from "./integrations.ts";
import { layoutErrorMessage, widgetDescription, widgetTitle } from "./labels.ts";
import { useWidgetUi, widgetUi } from "./ui-store.ts";

const CATEGORIES: Array<WidgetCategory | "all"> = [
  "all",
  "system",
  "storage",
  "network",
  "docker",
  "raspberryPi",
  "apps",
];
const PLACEMENTS: WidgetPlacement[] = ["desktop", "sidebar", "menubar"];

const chip =
  "rounded-full px-3 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent";

function adapterOf(manifest: WidgetManifest) {
  return manifest.categories.includes("apps")
    ? (manifest.provider as Exclude<
        WidgetManifest["provider"],
        "system" | "docker" | "raspberryPi"
      >)
    : null;
}

function GalleryCard({
  manifest,
  placement,
  blocked,
  integrationId,
  onAdded,
}: {
  manifest: WidgetManifest;
  placement: WidgetPlacement;
  /** Why it cannot be added (null when it can). */
  blocked: { text: string; action?: { label: string; run: () => void } } | null;
  integrationId: string | null;
  onAdded: (needsSetup: boolean, id: string) => void;
}) {
  const { t } = useTranslation();
  const sizes: WidgetSize[] = sizesFor(manifest, placement).filter((size) => size !== "custom");
  const [size, setSize] = useState<WidgetSize>(
    sizes.includes(manifest.defaultSize) ? manifest.defaultSize : (sizes[0] ?? "small"),
  );
  const [error, setError] = useState<string | null>(null);
  const effectiveSize = sizes.includes(size) ? size : sizes[0];
  const title = widgetTitle(t, manifest.id);

  const add = () => {
    const config = integrationId ? { integration: integrationId } : undefined;
    const result = widgetActions.add(manifest.id, placement, {
      ...(effectiveSize ? { size: effectiveSize } : {}),
      ...(config ? { config } : {}),
    });
    if (!result.ok) {
      setError(layoutErrorMessage(t, result.reason));
      return;
    }
    setError(null);
    onAdded(missingConfig(manifest, config ?? {}).length > 0, result.id);
  };

  return (
    <li
      className={cn(
        "glass-inset flex flex-col gap-2.5 rounded-everyos-lg p-3.5",
        blocked && "opacity-75",
      )}
      data-testid="gallery-item"
      data-widget={manifest.id}
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-xs leading-relaxed text-fg-muted">
          {widgetDescription(t, manifest.id)}
        </span>
      </div>
      {blocked ? (
        <div className="mt-auto flex flex-col items-start gap-1.5">
          <span className="text-xs text-fg-subtle">{blocked.text}</span>
          {blocked.action ? (
            <Button size="sm" variant="secondary" onClick={blocked.action.run}>
              {blocked.action.label}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
          {sizes.length > 1 ? (
            <div role="radiogroup" aria-label={t("widgets.gallery.size")} className="flex gap-1">
              {sizes.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={effectiveSize === option}
                  onClick={() => setSize(option)}
                  className={cn(
                    chip,
                    "px-2.5",
                    effectiveSize === option
                      ? "button-accent"
                      : "bg-hover/8 text-fg-muted hover:text-fg",
                  )}
                >
                  {t(`widgets.sizes.${option}`)}
                </button>
              ))}
            </div>
          ) : (
            <span className="text-xs text-fg-subtle">
              {effectiveSize ? t(`widgets.sizes.${effectiveSize}`) : null}
            </span>
          )}
          <Button size="sm" onClick={add} aria-label={`${t("widgets.gallery.add")}: ${title}`}>
            {t("widgets.gallery.add")}
          </Button>
          {error ? (
            <p className="w-full text-xs text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** Lists the built-in widgets with their availability on this host for this user. */
export function WidgetGallery() {
  const { t } = useTranslation();
  const gallery = useWidgetUi((state) => state.gallery);
  return (
    <Dialog
      open={gallery.open}
      onOpenChange={(open) => !open && widgetUi.closeGallery()}
      title={t("widgets.gallery.title")}
      description={t("widgets.gallery.description")}
      className="w-[min(96vw,920px)]"
    >
      {gallery.open ? (
        <GalleryBody initialPlacement={gallery.placement} initialCategory={gallery.category} />
      ) : null}
    </Dialog>
  );
}

function GalleryBody({
  initialPlacement,
  initialCategory,
}: {
  initialPlacement: WidgetPlacement;
  initialCategory: string | null;
}) {
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const canManageApps = permissions.includes("apps:manage");
  const [placement, setPlacement] = useState(initialPlacement);
  const [category, setCategory] = useState<WidgetCategory | "all">(
    (CATEGORIES as string[]).includes(initialCategory ?? "")
      ? (initialCategory as WidgetCategory)
      : "all",
  );
  const [query, setQuery] = useState("");
  const info = useApiResource<SystemInfo>(
    permissions.includes("system:read") ? "/system/info" : null,
    null,
  );
  const { integrations } = useIntegrations();
  const capabilities = info.data?.capabilities ?? null;

  const entries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(i18n.language);
    return BUILT_IN_WIDGETS.filter(
      (manifest) => category === "all" || manifest.categories.includes(category),
    )
      .filter(
        (manifest) =>
          !needle ||
          `${widgetTitle(t, manifest.id)} ${widgetDescription(t, manifest.id)}`
            .toLocaleLowerCase(i18n.language)
            .includes(needle),
      )
      .map((manifest) => {
        const availability = widgetAvailability(manifest, { permissions, capabilities });
        const adapter = adapterOf(manifest);
        const linked = adapter ? integrations.filter((i) => i.adapter === adapter) : [];
        let blocked: { text: string; action?: { label: string; run: () => void } } | null = null;
        if (!availability.ok)
          blocked = {
            text:
              availability.reason === "permission"
                ? t("widgets.gallery.noPermission")
                : t("widgets.gallery.noCapability", {
                    reason: t(`system.reasons.${availability.status.reason ?? "not-detected"}`),
                  }),
          };
        else if (!supportsPlacement(manifest, placement))
          blocked = { text: t("widgets.gallery.notForPlacement") };
        else if (adapter && linked.length === 0) {
          const app = t(`widgets.integrations.adapters.${adapter}`);
          blocked = canManageApps
            ? {
                text: t("widgets.gallery.needsIntegration", { app }),
                action: {
                  label: t("widgets.gallery.setupIntegration"),
                  run: () => {
                    widgetUi.closeGallery();
                    desktop.openSettings("widgets", { newAdapter: adapter });
                  },
                },
              }
            : { text: t("widgets.gallery.askAdmin", { app }) };
        }
        return { manifest, blocked, integrationId: linked[0]?.id ?? null };
      })
      .sort((a, b) => Number(Boolean(a.blocked)) - Number(Boolean(b.blocked)));
  }, [
    category,
    query,
    permissions,
    capabilities,
    integrations,
    placement,
    canManageApps,
    t,
    i18n.language,
  ]);

  const onAdded = (needsSetup: boolean, id: string) => {
    if (needsSetup) {
      widgetUi.closeGallery();
      widgetUi.configure(id);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="glass-inset flex h-9 min-w-48 flex-1 items-center gap-2 rounded-everyos-md px-3">
          <Search className="size-4 text-fg-subtle" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("widgets.gallery.search")}
            aria-label={t("widgets.gallery.search")}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-subtle"
          />
        </label>
        <div
          role="radiogroup"
          aria-label={t("widgets.gallery.placement")}
          className="glass-inset flex gap-1 rounded-full p-1"
        >
          {PLACEMENTS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={placement === option}
              onClick={() => setPlacement(option)}
              className={cn(
                chip,
                placement === option ? "button-accent" : "text-fg-muted hover:text-fg",
              )}
            >
              {t(`widgets.placements.${option}`)}
            </button>
          ))}
        </div>
      </div>
      <div role="tablist" aria-label={t("widgets.title")} className="flex flex-wrap gap-1.5">
        {CATEGORIES.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={category === option}
            onClick={() => setCategory(option)}
            className={cn(
              chip,
              category === option
                ? "bg-[rgb(var(--everyos-accent)/0.24)] text-fg"
                : "bg-hover/6 text-fg-muted hover:text-fg",
            )}
          >
            {t(`widgets.categories.${option}`)}
          </button>
        ))}
      </div>
      {entries.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-muted">{t("widgets.gallery.empty")}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => (
            <GalleryCard
              key={`${entry.manifest.id}-${placement}`}
              manifest={entry.manifest}
              placement={placement}
              blocked={entry.blocked}
              integrationId={entry.integrationId}
              onAdded={onAdded}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
