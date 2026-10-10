import type { AppJobView, CatalogAppView, CatalogView, InstalledAppView } from "@otuken/shared";
import { Package, Store } from "lucide-react";
import { Tabs } from "radix-ui";
import { useState } from "react";
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

const TABS = ["browse", "installed", "catalogs"] as const;
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
  const apps = useApiResource<{ apps: CatalogAppView[] }>("/catalogs/apps", 60_000);
  const installed = useApiResource<{ apps: InstalledAppView[] }>("/apps", 5000);
  const catalogs = useApiResource<{ catalogs: CatalogView[] }>(
    canCatalog ? "/catalogs" : null,
    60_000,
  );
  const reload = () => {
    apps.reload();
    catalogs.reload();
    installed.reload();
  };
  const onJob = (job: AppJobView) => {
    setJobId(job.id);
    installed.reload();
    setTab("installed");
  };
  const categories = [...new Set((apps.data?.apps ?? []).flatMap((app) => app.categories))].sort();
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
            className="whitespace-nowrap rounded-t-otk-sm border-b-2 border-transparent px-3 py-2 text-sm text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=active]:border-accent data-[state=active]:text-fg"
          >
            {t(`appStore.${value}`)}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {jobId ? (
          <div className="mb-4">
            <Progress key={jobId} id={jobId} onChanged={installed.reload} />
          </div>
        ) : null}
        <Tabs.Content value="browse" className="outline-none">
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
          <ResourceError error={apps.error} />
          {apps.loading ? (
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
                  className="glass-inset flex items-start gap-3 rounded-otk-md p-4 text-left outline-none transition-colors hover:bg-hover/8 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <div className="grid size-11 shrink-0 place-items-center rounded-otk-sm bg-accent/10 text-accent">
                    {app.icon ? (
                      <img
                        loading="lazy"
                        src={app.icon}
                        alt=""
                        className="size-10 rounded-otk-sm object-contain"
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
          {filtered.length > limit ? (
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
          <ResourceError error={installed.error} />
          {installed.loading ? (
            <LoadingBlock />
          ) : installed.data?.apps.length ? (
            installed.data.apps.map((app) => <InstalledCard key={app.id} app={app} onJob={onJob} />)
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
          </Tabs.Content>
        ) : null}
      </div>
      {selected ? (
        <InstallDialog app={selected} onClose={() => setSelected(null)} onJob={onJob} />
      ) : null}
      {adding ? <AddCatalog onClose={() => setAdding(false)} onChanged={reload} /> : null}
    </Tabs.Root>
  );
}
