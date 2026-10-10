import type { InstalledAppView, IntegrationAdapter } from "@otuken/shared";
import { getWidget, widgetsForAdapter, type WidgetManifest } from "@otuken/widget-sdk";
import { Check } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { usePermissions } from "../../stores/session-store.ts";
import { localized } from "../apps/store/parts.tsx";
import { desktop } from "../state/controller.ts";
import { widgetActions } from "./actions.ts";
import { useIntegrations } from "./integrations.ts";
import { layoutErrorMessage, widgetDescription, widgetTitle } from "./labels.ts";
import { useWidgetUi, widgetUi, type WidgetOffer } from "./ui-store.ts";

/** Offer for an installed app: its built-in adapter widgets plus the generic container widget. */
export function offerFor(app: InstalledAppView): WidgetOffer {
  const port = app.ports.find(
    (p) => !p.hostIp || ["0.0.0.0", "::", "127.0.0.1"].includes(p.hostIp),
  );
  return {
    appId: app.id,
    name: app.name,
    adapters: app.widgetAdapters,
    // The API runs on the same host, so a published port is reachable on loopback.
    baseUrl: port ? `${app.web.scheme}://127.0.0.1:${port.port}` : null,
  };
}

function OfferItem({
  manifest,
  config,
  disabled,
}: {
  manifest: WidgetManifest;
  config: Record<string, string>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li
      className="flex items-center justify-between gap-3 rounded-otk-md bg-hover/5 p-3"
      data-testid="offer-item"
      data-widget={manifest.id}
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">{widgetTitle(t, manifest.id)}</span>
        <span className="text-xs text-fg-muted">{widgetDescription(t, manifest.id)}</span>
        {error ? <span className="text-xs text-danger">{error}</span> : null}
      </div>
      <Button
        size="sm"
        variant={added ? "ghost" : "secondary"}
        disabled={disabled || added}
        onClick={() => {
          const result = widgetActions.add(manifest.id, "desktop", { config });
          if (result.ok) setAdded(true);
          else setError(layoutErrorMessage(t, result.reason));
        }}
      >
        {added ? <Check className="size-4" aria-hidden /> : null}
        {added
          ? t("widgets.gallery.added", { name: widgetTitle(t, manifest.id) })
          : t("widgets.gallery.add")}
      </Button>
    </li>
  );
}

function AdapterSection({ offer, adapter }: { offer: WidgetOffer; adapter: IntegrationAdapter }) {
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const canManage = permissions.includes("apps:manage");
  const { integrations, loading } = useIntegrations();
  const candidates = integrations.filter((i) => i.adapter === adapter);
  const integration = candidates.find((i) => i.appId === offer.appId) ?? candidates[0];
  const app = t(`widgets.integrations.adapters.${adapter}`);
  return (
    <section className="flex flex-col gap-2" aria-label={app}>
      <h3 className="text-sm font-semibold">{app}</h3>
      {!loading && !integration ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-otk-md bg-hover/5 p-3 text-xs text-fg-muted">
          <span>
            {canManage ? t("widgets.offer.connect") : t("widgets.gallery.askAdmin", { app })}
          </span>
          {canManage ? (
            <Button
              size="sm"
              onClick={() => {
                widgetUi.offer(null);
                desktop.openSettings("widgets", {
                  newAdapter: adapter,
                  draft: {
                    appId: offer.appId,
                    name: localized(offer.name, i18n.language) || app,
                    ...(offer.baseUrl ? { baseUrl: offer.baseUrl } : {}),
                  },
                });
              }}
            >
              {t("widgets.gallery.setupIntegration")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ul className="flex flex-col gap-2">
        {widgetsForAdapter(adapter)
          .filter((manifest) => manifest.permissions.every((p) => permissions.includes(p)))
          .map((manifest) => (
            <OfferItem
              key={manifest.id}
              manifest={manifest}
              config={integration ? { integration: integration.id } : {}}
              disabled={!integration}
            />
          ))}
      </ul>
    </section>
  );
}

/** "Available widgets for <app>, add to desktop?" shown after installing an app. */
export function WidgetOfferDialog() {
  const { t, i18n } = useTranslation();
  const offer = useWidgetUi((state) => state.offer);
  const permissions = usePermissions();
  const container = getWidget("docker.app");
  const canDocker = Boolean(
    container && container.permissions.every((p) => permissions.includes(p)),
  );
  return (
    <Dialog
      open={offer !== null}
      onOpenChange={(open) => !open && widgetUi.offer(null)}
      title={t("widgets.offer.title")}
      description={
        offer ? t("widgets.offer.body", { app: localized(offer.name, i18n.language) }) : undefined
      }
    >
      {offer ? (
        <div className="flex flex-col gap-5" data-testid="widget-offer">
          {canDocker && container ? (
            <ul className="flex flex-col gap-2">
              <OfferItem
                manifest={container}
                config={{ target: `app:${offer.appId}` }}
                disabled={false}
              />
            </ul>
          ) : null}
          {offer.adapters.map((adapter) => (
            <AdapterSection key={adapter} offer={offer} adapter={adapter} />
          ))}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => widgetUi.offer(null)}>
              {t("widgets.offer.later")}
            </Button>
            <Button variant="secondary" onClick={() => widgetUi.openGallery("desktop", "apps")}>
              {t("widgets.offer.show")}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
