import type {
  AppJobView,
  CatalogAppView,
  CatalogView,
  DesktopAppInstallationView,
  DesktopAppListing,
  DesktopAppRegistryView,
  InstalledAppView,
} from "@everyos/shared";
import { Package, Store } from "lucide-react";
import { Tabs } from "radix-ui";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { useAppStateField } from "../app-context.ts";
import { LoadingBlock, ResourceError } from "../system/parts.tsx";
import { AddCatalog, CatalogCard } from "./catalogs.tsx";
import { InstallDialog } from "./install-dialog.tsx";
import { InstalledCard } from "./installed.tsx";
import { localized, Progress } from "./parts.tsx";
import { offerFor } from "../../widgets/offer.tsx";
import { widgetUi } from "../../widgets/ui-store.ts";
import { api } from "../../../lib/api.ts";
import { DesktopAppDialog } from "./desktop-app-dialog.tsx";
import { AddRegistryDialog, RegistryCard } from "./desktop-registries.tsx";
import { useDesktopApps } from "../../desktop-apps/store.ts";

const TABS = ["browse", "installed", "catalogs"] as const;
const TYPES = ["all", "docker", "desktop", "hybrid"] as const;
const SOURCES = ["all", "official", "community", "private"] as const;
export default function StoreApp() {
  const { t, i18n } = useTranslation();
  const canCatalog = usePermissions().includes("catalogs:manage");
  const [tab, setTab] = useAppStateField("tab", TABS, "browse");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [limit, setLimit] = useState(100);
  const [selected, setSelected] = useState<CatalogAppView | null>(null);
  const [adding, setAdding] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobNoticeHidden, setJobNoticeHidden] = useState(false);
  const [type, setType] = useState<(typeof TYPES)[number]>("all");
  const [source, setSource] = useState<(typeof SOURCES)[number]>("all");
  const [updatesOnly, setUpdatesOnly] = useState(false);
  const [desktopSelected, setDesktopSelected] = useState<{
    listing: DesktopAppListing | null;
    installation: DesktopAppInstallationView | null;
  } | null>(null);
  const [addingRegistry, setAddingRegistry] = useState(false);
  const names = useDesktopApps((state) => state.names);
  const apps = useApiResource<{ apps: CatalogAppView[] }>("/catalogs/apps", 60_000);
  const desktopListings = useApiResource<{ apps: DesktopAppListing[] }>(
    "/desktop-apps/catalog",
    60_000,
  );
  const desktopInstalled = useApiResource<{ apps: DesktopAppInstallationView[] }>(
    "/desktop-apps/installed",
    10_000,
  );
  const registries = useApiResource<{ registries: DesktopAppRegistryView[] }>(
    canCatalog ? "/desktop-apps/registries" : null,
    60_000,
  );
  const installed = useApiResource<{ apps: InstalledAppView[] }>("/apps", 5000);
  const catalogs = useApiResource<{ catalogs: CatalogView[] }>(
    canCatalog ? "/catalogs" : null,
    60_000,
  );
  const reload = () => {
    apps.reload();
    catalogs.reload();
    installed.reload();
    desktopListings.reload();
    desktopInstalled.reload();
    registries.reload();
  };
  const installationOf = (appId: string) =>
    desktopInstalled.data?.apps.find((entry) => entry.appId === appId) ?? null;
  const listingOf = (installation: DesktopAppInstallationView) =>
    desktopListings.data?.apps.find(
      (entry) =>
        entry.appId === installation.appId && entry.registry.id === installation.registry?.id,
    ) ?? null;
  const term = search.toLocaleLowerCase(i18n.language);
  const desktopFiltered = (desktopListings.data?.apps ?? []).filter((listing) => {
    const hybrid = listing.permissions.some((p) => p.capability.startsWith("integration:"));
    return (
      (type === "all" || (type === "hybrid" ? hybrid : type === "desktop" && !hybrid)) &&
      (source === "all" || listing.registry.kind === source) &&
      (!updatesOnly || listing.updateAvailable !== null) &&
      (!category || listing.category === category) &&
      `${listing.name} ${listing.description} ${listing.publisher.name}`
        .toLocaleLowerCase(i18n.language)
        .includes(term)
    );
  });
  const showDocker = (type === "all" || type === "docker") && source === "all" && !updatesOnly;
  const onJob = (job: AppJobView) => {
    setJobId(job.id);
    setJobNoticeHidden(false);
    installed.reload();
    setTab("installed");
  };
  // A freshly installed app offers its widgets ("Available widgets…, add to desktop?").
  const onFinished = useCallback((job: AppJobView) => {
    if (job.action !== "install" || job.stage !== "succeeded") return;
    void api<{ apps: InstalledAppView[] }>("/apps")
      .then(({ apps: list }) => {
        const app = list.find((entry) => entry.id === job.appId);
        if (app) widgetUi.offer(offerFor(app));
      })
      .catch(() => undefined);
  }, []);
  const categories = [
    ...new Set([
      ...(apps.data?.apps ?? []).flatMap((app) => app.categories),
      ...(desktopListings.data?.apps ?? []).map((listing) => listing.category),
    ]),
  ].sort();
  const filtered = (apps.data?.apps ?? []).filter(
    (app) =>
      (!category || app.categories.includes(category)) &&
      `${localized(app.name, i18n.language)} ${localized(app.description, i18n.language)}`
        .toLocaleLowerCase(i18n.language)
        .includes(search.toLocaleLowerCase(i18n.language)),
  );
  return (
    <Tabs.Root
      value={tab === "catalogs" && !canCatalog ? "browse" : tab}
      onValueChange={(value) => setTab(value as typeof tab)}
      className="flex h-full min-h-0 flex-col"
    >
      <Tabs.List
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 pt-2"
        aria-label={t("apps.store")}
      >
        {TABS.filter((value) => value !== "catalogs" || canCatalog).map((value) => (
          <Tabs.Trigger
            key={value}
            value={value}
            className="whitespace-nowrap rounded-t-everyos-sm border-b-2 border-transparent px-3 py-2 text-sm text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=active]:border-accent data-[state=active]:text-fg"
          >
            {t(`appStore.${value}`)}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {jobId ? (
          <div className={jobNoticeHidden ? undefined : "mb-4"}>
            <Progress
              key={jobId}
              id={jobId}
              onChanged={installed.reload}
              onFinished={onFinished}
              dismissed={jobNoticeHidden}
              onDismiss={() => setJobNoticeHidden(true)}
            />
          </div>
        ) : null}
        <Tabs.Content value="browse" className="outline-none">
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <Select
              label={t("desktopApps.store.typeFilter")}
              value={type}
              onChange={(value) => setType(value)}
              options={TYPES.map((value) => ({
                value,
                label: t(`desktopApps.store.types.${value}`),
              }))}
            />
            <Select
              label={t("desktopApps.store.sourceFilter")}
              value={source}
              onChange={(value) => setSource(value)}
              options={SOURCES.map((value) => ({
                value,
                label: t(
                  value === "all"
                    ? "desktopApps.store.allSources"
                    : `desktopApps.store.sources.${value}`,
                ),
              }))}
            />
            <label className="flex h-10 items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={updatesOnly}
                onChange={(event) => setUpdatesOnly(event.target.checked)}
                className="size-4 accent-[rgb(var(--everyos-accent))]"
              />
              {t("desktopApps.store.updatesOnly")}
            </label>
          </div>
          <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_200px]">
            <Field
              label={t("appStore.search")}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(100);
              }}
            />
            <Select
              label={t("appStore.category")}
              value={category}
              onChange={(value) => {
                setCategory(value);
                setLimit(100);
              }}
              options={[
                { value: "", label: t("appStore.allCategories") },
                ...categories.map((value) => ({ value, label: value })),
              ]}
            />
          </div>
          <ResourceError error={desktopListings.error} />
          {desktopFiltered.length ? (
            <div
              className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              data-testid="desktop-app-listings"
            >
              {desktopFiltered.map((listing) => (
                <button
                  key={`${listing.registry.id}:${listing.appId}`}
                  type="button"
                  data-testid="desktop-app-listing"
                  data-app-id={listing.appId}
                  onClick={() =>
                    setDesktopSelected({ listing, installation: installationOf(listing.appId) })
                  }
                  className="glass-inset flex items-start gap-3 rounded-everyos-md p-4 text-left outline-none transition-colors hover:bg-hover/8 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <img
                    loading="lazy"
                    src={`/api/desktop-apps/catalog/${listing.registry.id}/${listing.appId}/icon`}
                    alt=""
                    className="size-11 shrink-0 rounded-everyos-sm object-contain"
                  />
                  <div className="min-w-0">
                    <h3 className="font-semibold">{names[listing.appId] ?? listing.name}</h3>
                    <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-fg-muted">
                      {listing.description}
                    </p>
                    <p className="mt-2 flex flex-wrap gap-1.5 text-xs">
                      <span className="rounded-full bg-[rgb(var(--everyos-accent)/0.15)] px-2 py-0.5 text-[rgb(var(--everyos-accent))]">
                        {t(`desktopApps.store.sources.${listing.registry.kind}`)}
                      </span>
                      <span className="text-fg-subtle">
                        {listing.publisher.name} · {listing.version}
                      </span>
                    </p>
                    {listing.installed ? (
                      <p className="mt-1 text-xs text-success">
                        {listing.updateAvailable
                          ? t("desktopApps.store.updateTo", { version: listing.updateAvailable })
                          : t("desktopApps.store.installed")}
                      </p>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          ) : null}
          <ResourceError error={showDocker ? apps.error : null} />
          {!showDocker ? (
            desktopFiltered.length ? null : (
              <p className="py-10 text-center text-sm text-fg-muted">{t("appStore.noResults")}</p>
            )
          ) : apps.loading ? (
            <LoadingBlock />
          ) : !filtered.length ? (
            <p className="py-10 text-center text-sm text-fg-muted">
              {t(apps.data?.apps.length ? "appStore.noResults" : "appStore.empty")}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.slice(0, limit).map((app) => (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => setSelected(app)}
                  className="glass-inset flex items-start gap-3 rounded-everyos-md p-4 text-left outline-none transition-colors hover:bg-hover/8 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <div className="grid size-11 shrink-0 place-items-center rounded-everyos-sm bg-accent/10 text-accent">
                    {app.icon ? (
                      <img
                        loading="lazy"
                        src={app.icon}
                        alt=""
                        className="size-10 rounded-everyos-sm object-contain"
                        onError={(event) => {
                          event.currentTarget.hidden = true;
                        }}
                      />
                    ) : (
                      <Package className="size-6" aria-hidden />
                    )}
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold">{localized(app.name, i18n.language)}</h3>
                    <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-fg-muted">
                      {localized(app.description, i18n.language)}
                    </p>
                    <p className="mt-2 text-xs text-fg-subtle">
                      {app.source.format}
                      {app.version ? ` · ${app.version}` : ""}
                    </p>
                    {app.duplicates.length ? (
                      <p className="mt-1 text-xs text-accent">{t("appStore.duplicate")}</p>
                    ) : null}
                    {app.blockers.length ? (
                      <p className="mt-1 text-xs text-danger">{t("appStore.unsupported")}</p>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          )}
          {showDocker && filtered.length > limit ? (
            <Button
              variant="secondary"
              className="mt-4"
              onClick={() => setLimit((previous) => previous + 100)}
            >
              {t("appStore.more")}
            </Button>
          ) : null}
        </Tabs.Content>
        <Tabs.Content value="installed" className="flex flex-col gap-3 outline-none">
          {desktopInstalled.data?.apps.length ? (
            <section className="flex flex-col gap-2" data-testid="desktop-apps-installed">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                {t("desktopApps.store.installedSection")}
              </h3>
              {desktopInstalled.data.apps.map((installation) => (
                <button
                  key={installation.appId}
                  type="button"
                  onClick={() =>
                    setDesktopSelected({ listing: listingOf(installation), installation })
                  }
                  className="glass-inset flex items-center gap-3 rounded-everyos-md p-3 text-left outline-none hover:bg-hover/8 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <img
                    src={`${installation.runtimeUrl}${installation.icon}`}
                    alt=""
                    className="size-9 shrink-0 rounded-everyos-sm object-contain"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {names[installation.appId] ?? installation.name}
                    </span>
                    <span className="block text-xs text-fg-muted">
                      {installation.version}
                      {installation.state !== "active"
                        ? ` · ${t(`desktopApps.store.state.${installation.state}`)}`
                        : ""}
                      {listingOf(installation)?.updateAvailable
                        ? ` · ${t("desktopApps.store.updateTo", { version: listingOf(installation)!.updateAvailable })}`
                        : ""}
                    </span>
                  </span>
                </button>
              ))}
            </section>
          ) : null}
          <ResourceError error={installed.error} />
          {installed.loading ? (
            <LoadingBlock />
          ) : installed.data?.apps.length ? (
            installed.data.apps.map((app) => (
              <InstalledCard key={app.id} app={app} onJob={onJob} onChanged={installed.reload} />
            ))
          ) : (
            <p className="py-10 text-center text-sm text-fg-muted">
              {t("appStore.installedEmpty")}
            </p>
          )}
        </Tabs.Content>
        {canCatalog ? (
          <Tabs.Content value="catalogs" className="flex flex-col gap-3 outline-none">
            <div className="flex items-center justify-between gap-3">
              <Store className="size-5 text-accent" aria-hidden />
              <Button onClick={() => setAdding(true)}>{t("appStore.addCatalog")}</Button>
            </div>
            <ResourceError error={catalogs.error} />
            {catalogs.loading ? (
              <LoadingBlock />
            ) : (
              catalogs.data?.catalogs.map((catalog) => (
                <CatalogCard key={catalog.id} catalog={catalog} onChanged={reload} />
              ))
            )}
            <div className="mt-4 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-fg">{t("desktopApps.registries.title")}</h3>
              <Button variant="secondary" onClick={() => setAddingRegistry(true)}>
                {t("desktopApps.registries.add")}
              </Button>
            </div>
            <ResourceError error={registries.error} />
            {registries.data?.registries.map((registry) => (
              <RegistryCard key={registry.id} registry={registry} onChanged={reload} />
            ))}
          </Tabs.Content>
        ) : null}
      </div>
      {selected ? (
        <InstallDialog
          app={selected}
          onClose={() => setSelected(null)}
          onJob={onJob}
          sources={installed.data?.apps ?? []}
        />
      ) : null}
      {adding ? <AddCatalog onClose={() => setAdding(false)} onChanged={reload} /> : null}
      {addingRegistry ? (
        <AddRegistryDialog onClose={() => setAddingRegistry(false)} onChanged={reload} />
      ) : null}
      {desktopSelected ? (
        <DesktopAppDialog
          key={`${desktopSelected.listing?.appId ?? desktopSelected.installation?.appId}`}
          listing={desktopSelected.listing}
          installation={desktopSelected.installation}
          onClose={() => setDesktopSelected(null)}
          onChanged={(installation) => {
            reload();
            // Stays open on the app as it is now, so it can be opened right after installing.
            setDesktopSelected((current) =>
              installation && current ? { ...current, installation } : null,
            );
          }}
        />
      ) : null}
    </Tabs.Root>
  );
}
