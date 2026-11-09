import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Tabs } from "radix-ui";
import { Box, Globe, Link, Monitor, RefreshCw, Search, Upload } from "lucide-react";
import {
  SHORTCUT_PREFIX,
  MAX_FOLDER_ICON_BYTES,
  isShortcutIcon,
  isShortcutUrl,
  type CustomShortcut,
  type DockerContainerView,
  type InstalledAppView,
  type WallpaperInfo,
} from "@everyos/shared";
import { workArea } from "@everyos/window-manager";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Field } from "../../components/ui/field.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { TabsList } from "../../components/ui/tabs-list.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { api } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { useApiResource } from "../../features/system/use-api-resource.ts";
import { usePermissions, useSessionStore } from "../../stores/session-store.ts";
import { AppIcon, ShortcutImage } from "../apps/app-icon.tsx";
import { appTitle } from "../apps/app-title.ts";
import { allowedApps, getApp, isAppAllowed } from "../apps/registry.ts";
import { localized } from "../apps/localized.ts";
import { appLaunchLinks } from "../apps/store/launch-links.ts";
import {
  installedAppId,
  rememberInstalledApps,
  useInstalledApps,
} from "../apps/store/installed-apps-store.ts";
import { loadDesktopApps, useDesktopApps } from "../desktop-apps/store.ts";
import { usePreferences } from "../state/preferences-store.ts";
import { newId } from "../state/ids.ts";
import { wm } from "../state/window-store.ts";
import { gridMetrics } from "../surface/icon-grid.ts";
import { useThemeStore } from "../theme/theme-store.ts";
import {
  closeShortcutDialog,
  useShortcutDialog,
  type ShortcutDialogRequest,
} from "./dialog-store.ts";
import { containerShortcutUrls, type ShortcutCandidate } from "./model.ts";
import { saveCustomShortcut } from "./state.ts";

function ShortcutForm({ request }: { request: ShortcutDialogRequest }) {
  const formId = useId();
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const canApps = permissions.includes("apps:read");
  const canDocker = permissions.includes("docker:read");
  useInstalledApps((state) => state.apps);
  const desktopApps = useDesktopApps((state) => state.apps);
  const shortcuts = usePreferences((state) => state.shortcuts.entries);
  const original = shortcuts.find((entry) => entry.id === request.shortcutId);
  const initial = request.appId ? getApp(request.appId) : undefined;
  const originalApp = original?.target.kind === "app" ? getApp(original.target.appId) : undefined;
  const originalUrl =
    original?.target.kind === "url"
      ? original.target.url
      : originalApp?.installedApp
        ? (appLaunchLinks(originalApp.installedApp, window.location.hostname)[0]?.href ?? "")
        : "";
  const [source, setSource] = useState<CustomShortcut["source"]>(
    original?.source ??
      (initial
        ? initial.installedApp
          ? "docker"
          : "official"
        : canApps || canDocker
          ? "docker"
          : "manual"),
  );
  const [selected, setSelected] = useState<ShortcutCandidate | null>(() =>
    original
      ? {
          id: original.id,
          name: original.name,
          detail: "",
          source: original.source,
          permission: original.permission,
          target: original.target,
          url: originalUrl,
          icon: original.icon,
          simulated: originalApp?.installedApp?.source === "simulated",
          ...(getApp(original.id) ? { manifest: getApp(original.id)! } : {}),
        }
      : initial
        ? {
            id: initial.id,
            name: appTitle(initial, t),
            detail: "",
            source: initial.installedApp ? "docker" : "official",
            permission: initial.installedApp ? "apps:read" : null,
            target: { kind: "app", appId: initial.id },
            url: initial.installedApp
              ? (appLaunchLinks(initial.installedApp, window.location.hostname)[0]?.href ?? "")
              : "",
            icon: null,
            simulated: initial.installedApp?.source === "simulated",
            manifest: initial,
          }
        : null,
  );
  const [name, setName] = useState(original?.name ?? (initial ? appTitle(initial, t) : ""));
  const [url, setUrl] = useState(
    original?.target.kind === "url" ? original.target.url : (selected?.url ?? ""),
  );
  const [icon, setIcon] = useState(original?.icon ?? "");
  const [search, setSearch] = useState("");
  const [destination, setDestination] = useState<"desktop" | "dock" | "both">(request.destination);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [officialLoading, setOfficialLoading] = useState(false);
  const [officialError, setOfficialError] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const controller = useRef(new AbortController());
  useEffect(() => () => controller.current.abort(), []);
  const managed = useApiResource<{ apps: InstalledAppView[] }>(
    source === "docker" && canApps ? "/apps" : null,
    null,
  );
  const containers = useApiResource<{
    source: "host" | "simulated";
    containers: DockerContainerView[];
  }>(source === "docker" && canDocker ? "/docker/containers" : null, null);
  useEffect(() => {
    if (managed.data) rememberInstalledApps(managed.data.apps);
  }, [managed.data]);
  useEffect(() => {
    if (source !== "official" || !canApps) return;
    const abort = new AbortController();
    const load = async () => {
      setOfficialLoading(true);
      setOfficialError(false);
      try {
        await loadDesktopApps(i18n.language, abort.signal);
      } catch {
        if (!abort.signal.aborted) setOfficialError(true);
      } finally {
        if (!abort.signal.aborted) setOfficialLoading(false);
      }
    };
    void load();
    return () => abort.abort();
  }, [source, canApps, i18n.language, refresh]);
  const candidates = useMemo<ShortcutCandidate[]>(() => {
    if (source === "manual") return [];
    if (source === "official")
      return allowedApps(permissions, { desktopApps })
        .filter((app) => !app.desktopApp || app.desktopApp.registry?.kind === "official")
        .map((app) => ({
          id: app.id,
          name: appTitle(app, t),
          detail: t(app.desktopApp ? "shortcuts.installed" : "shortcuts.builtIn"),
          source: "official",
          permission: null,
          target: { kind: "app", appId: app.id },
          url: "",
          icon: null,
          manifest: app,
          simulated: false,
        }));
    const apps = managed.data?.apps ?? [];
    const projects = new Set(apps.map((app) => app.project));
    return [
      ...apps.map((app): ShortcutCandidate => {
        const id = installedAppId(app.id);
        const manifest = getApp(id);
        return {
          id,
          name: localized(app.name, i18n.language),
          detail: t("shortcuts.managed"),
          source: "docker",
          permission: "apps:read",
          target: { kind: "app", appId: id },
          url: appLaunchLinks(app, window.location.hostname)[0]?.href ?? "",
          icon: app.icon && isShortcutIcon(app.icon) ? app.icon : null,
          simulated: app.source === "simulated",
          ...(manifest ? { manifest } : {}),
        };
      }),
      ...(containers.data?.containers ?? [])
        .filter((container) => !container.project || !projects.has(container.project))
        .map((container): ShortcutCandidate => {
          const url =
            containerShortcutUrls(
              container,
              window.location.hostname,
              containers.data?.source === "simulated",
            )[0] ?? "";
          return {
            id: container.id,
            name: container.name,
            detail: container.image,
            source: "docker",
            permission: "docker:read",
            target: { kind: "url", url },
            url,
            icon: container.icon && isShortcutIcon(container.icon) ? container.icon : null,
            simulated: containers.data?.source === "simulated",
          };
        }),
    ];
  }, [source, permissions, desktopApps, managed.data, containers.data, i18n.language, t]);
  const shown = candidates
    .filter((candidate) =>
      `${candidate.name} ${candidate.detail}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
    )
    .slice(0, 100);
  const busy =
    source === "docker"
      ? (canApps && (managed.loading || managed.refreshing)) ||
        (canDocker && (containers.loading || containers.refreshing))
      : officialLoading;
  const native = selected?.source === "official" && selected.target.kind === "app";
  const useAppTarget = selected?.target.kind === "app" && (native || url === selected.url);
  const validUrl = useAppTarget || isShortcutUrl(url.trim());
  const validIcon = !icon.trim() || isShortcutIcon(icon.trim());
  const canSave = Boolean(
    (source === "manual" || selected) &&
    name.trim() &&
    validUrl &&
    validIcon &&
    permissions.includes("preferences:manage"),
  );
  const choose = (candidate: ShortcutCandidate) => {
    setSelected(candidate);
    setName(candidate.name);
    setUrl(candidate.url);
    setIcon(candidate.icon ?? "");
    setError(null);
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > MAX_FOLDER_ICON_BYTES
    ) {
      setError(t("shortcuts.uploadError"));
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const image = await api<WallpaperInfo>("/folder-icons", {
        method: "POST",
        raw: { body: file, contentType: file.type },
        signal: controller.current.signal,
      });
      setIcon(`/api/folder-icons/${image.id}/image`);
    } catch {
      if (!controller.current.signal.aborted) setError(t("shortcuts.uploadError"));
    } finally {
      if (!controller.current.signal.aborted) setUploading(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    const manifest = selected?.target.kind === "app" ? getApp(selected.target.appId) : null;
    if (useAppTarget && (!manifest || !isAppAllowed(manifest, permissions))) {
      setError(t("shortcuts.appUnavailable"));
      return;
    }
    const entry: CustomShortcut = {
      id: original?.id ?? SHORTCUT_PREFIX + newId("s"),
      name: name.trim(),
      source,
      permission: source === "manual" ? null : (selected?.permission ?? null),
      icon: icon.trim() && !(useAppTarget && icon.trim() === selected?.icon) ? icon.trim() : null,
      target:
        useAppTarget && selected?.target.kind === "app"
          ? selected.target
          : { kind: "url", url: url.trim() },
    };
    const metrics =
      request.metrics ??
      gridMetrics(useThemeStore.getState().theme.iconSize, workArea(wm().viewport));
    const desktopId = request.desktopId ?? wm().activeDesktopId;
    if (
      !saveCustomShortcut(entry, {
        editing: Boolean(original),
        desktopId,
        metrics,
        desktop: destination !== "dock",
        dock: destination !== "desktop",
      })
    )
      setError(t("shortcuts.limit"));
    else closeShortcutDialog();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeShortcutDialog();
      }}
      title={t(original ? "shortcuts.editTitle" : "shortcuts.title")}
      description={t("shortcuts.description")}
      className="!z-[8500] w-[min(94vw,780px)]"
      overlayClassName="!z-[8490]"
      footer={
        <>
          <Button variant="ghost" onClick={closeShortcutDialog}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={!canSave || uploading}>
            {t(original ? "shortcuts.save" : "shortcuts.add")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={submit}
        className="min-w-0 space-y-4"
        data-testid="shortcut-dialog"
      >
        <Tabs.Root
          className="space-y-4"
          value={source}
          onValueChange={(value) => {
            setSource(value as CustomShortcut["source"]);
            setSelected(null);
            setSearch("");
            setError(null);
          }}
        >
          <TabsList
            className="grid grid-cols-3 gap-1 rounded-everyos-md bg-hover/5 p-1"
            aria-label={t("shortcuts.title")}
          >
            {(
              [
                ["docker", Box],
                ["official", Monitor],
                ["manual", Link],
              ] as const
            ).map(([tab, Icon]) => (
              <Tabs.Trigger
                key={tab}
                value={tab}
                className="flex h-11 items-center justify-center gap-2 rounded-everyos-sm text-sm outline-none data-[state=active]:bg-hover/10 data-[state=active]:text-accent focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Icon className="size-4" aria-hidden />
                {t(`shortcuts.${tab}`)}
              </Tabs.Trigger>
            ))}
          </TabsList>
          <Tabs.Content value={source} asChild>
            <div
              className={cn(
                "grid min-w-0 gap-5",
                source !== "manual" && "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]",
              )}
            >
              {source !== "manual" ? (
                <section className="min-w-0 space-y-3">
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <Field
                        label={t("shortcuts.search")}
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        trailing={<Search className="size-4" aria-hidden />}
                      />
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("shortcuts.refresh")}
                      onClick={() => {
                        managed.reload();
                        containers.reload();
                        setRefresh((value) => value + 1);
                      }}
                    >
                      <RefreshCw
                        className={cn("size-4", busy && "animate-spin motion-reduce:animate-none")}
                      />
                    </Button>
                  </div>
                  {busy && !shown.length ? (
                    <div className="grid h-28 place-items-center" role="status">
                      <Spinner />
                    </div>
                  ) : null}
                  <ul className="max-h-64 space-y-1 overflow-y-auto rounded-everyos-md border border-line p-1">
                    {shown.map((candidate) => (
                      <li key={candidate.id}>
                        <button
                          type="button"
                          onClick={() => choose(candidate)}
                          aria-pressed={selected?.id === candidate.id}
                          className={cn(
                            "flex min-h-14 w-full items-center gap-3 rounded-everyos-sm px-2.5 py-2 text-left outline-none hover:bg-hover/8 focus-visible:ring-2 focus-visible:ring-accent",
                            selected?.id === candidate.id &&
                              "bg-accent/10 ring-1 ring-inset ring-accent/40",
                          )}
                        >
                          {candidate.manifest ? (
                            <AppIcon manifest={candidate.manifest} size={34} />
                          ) : candidate.icon ? (
                            <ShortcutImage
                              src={candidate.icon}
                              size={34}
                              fallback={<Box className="size-8 shrink-0 text-accent" aria-hidden />}
                            />
                          ) : (
                            <Box className="size-8 shrink-0 text-accent" aria-hidden />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {candidate.name}
                            </span>
                            <span className="block truncate text-xs text-fg-subtle">
                              {candidate.simulated ? t("shortcuts.simulated") : candidate.detail}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                    {!busy && !shown.length ? (
                      <li className="px-3 py-5 text-sm text-fg-muted">
                        {t(search ? "shortcuts.noResults" : "shortcuts.empty")}
                      </li>
                    ) : null}
                  </ul>
                  {source === "docker" &&
                  ((canApps && managed.error) || (canDocker && containers.error)) ? (
                    <Alert tone="warning">{t("shortcuts.dockerError")}</Alert>
                  ) : null}
                  {source === "docker" && !canApps && !canDocker ? (
                    <p className="text-xs text-fg-muted">{t("shortcuts.permissionHint")}</p>
                  ) : null}
                  {source === "official" && officialError ? (
                    <Alert tone="warning">{t("shortcuts.officialError")}</Alert>
                  ) : null}
                </section>
              ) : null}
              <section className="min-w-0 space-y-3">
                <div
                  className="flex items-center gap-3 rounded-everyos-md border border-line bg-hover/5 p-3"
                  aria-label={t("shortcuts.preview")}
                >
                  {icon.trim() && validIcon ? (
                    <ShortcutImage
                      src={icon.trim()}
                      size={48}
                      fallback={<Globe className="size-10 shrink-0 text-accent" aria-hidden />}
                    />
                  ) : selected?.manifest ? (
                    <AppIcon manifest={selected.manifest} size={48} />
                  ) : (
                    <Globe className="size-10 shrink-0 text-accent" aria-hidden />
                  )}
                  <span className="min-w-0 truncate text-sm font-medium">
                    {name || t("shortcuts.preview")}
                  </span>
                </div>
                <Field
                  label={t("shortcuts.name")}
                  value={name}
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
                {native ? (
                  <p className="rounded-everyos-sm bg-hover/5 p-2.5 text-sm text-fg-muted">
                    {t("shortcuts.internal")}
                  </p>
                ) : (
                  <Field
                    label={t("shortcuts.url")}
                    value={url}
                    maxLength={2048}
                    onChange={(event) => setUrl(event.target.value)}
                    error={url && !validUrl ? t("shortcuts.invalidUrl") : undefined}
                    hint={
                      selected?.simulated
                        ? t("shortcuts.simulatedHint")
                        : useAppTarget
                          ? t("shortcuts.automaticAddress")
                          : source === "docker"
                            ? t("shortcuts.urlHint")
                            : undefined
                    }
                  />
                )}
                <Field
                  label={t("shortcuts.icon")}
                  value={icon}
                  maxLength={2048}
                  onChange={(event) => setIcon(event.target.value)}
                  error={!validIcon ? t("shortcuts.invalidIcon") : undefined}
                />
                <p className="text-xs leading-relaxed text-fg-muted">{t("shortcuts.iconHint")}</p>
                <input
                  ref={uploadInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    void upload(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={uploading}
                  onClick={() => uploadInput.current?.click()}
                >
                  <Upload className="size-4" aria-hidden />
                  {t("shortcuts.upload")}
                </Button>
              </section>
            </div>
          </Tabs.Content>
        </Tabs.Root>
        {original ? (
          <p className="text-xs text-fg-muted">{t("shortcuts.editedEverywhere")}</p>
        ) : (
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-fg-muted">
              {t("shortcuts.destination")}
            </legend>
            <div className="flex gap-2">
              {(["desktop", "dock", "both"] as const).map((place) => (
                <Button
                  key={place}
                  size="sm"
                  variant={destination === place ? "primary" : "secondary"}
                  aria-pressed={destination === place}
                  onClick={() => setDestination(place)}
                >
                  {t(`shortcuts.${place}`)}
                </Button>
              ))}
            </div>
          </fieldset>
        )}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </form>
    </Dialog>
  );
}

export function ShortcutDialogHost() {
  const request = useShortcutDialog((state) => state.request);
  const owner = useShortcutDialog((state) => state.sessionId);
  const sessionId = useSessionStore((state) => state.session?.session.id);
  const locked = useSessionStore((state) => state.locked);
  useEffect(() => {
    closeShortcutDialog();
  }, [sessionId, locked]);
  useEffect(() => () => closeShortcutDialog(), []);
  return request && !locked && sessionId === owner ? <ShortcutForm request={request} /> : null;
}
