import type { AppJobView, InstalledAppView } from "@everyos/shared";
import type { Point, Rect } from "@everyos/window-manager";
import { Info, RefreshCw } from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { IconLabel } from "../../../components/ui/icon-label.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { cn } from "../../../lib/cn.ts";
import { iconsInRect, selectionRect, selectIcon } from "../../surface/icon-selection.ts";
import { LoadingBlock, ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { InstalledCard } from "./installed.tsx";
import { InstalledAppIcon } from "./installed-icon.tsx";
import { appLaunchLinks } from "./launch-links.ts";
import { localized, Progress } from "./parts.tsx";

/** A live folder of managed applications; never copies or relocates host app data. */
export default function ApplicationsApp() {
  const { t, i18n } = useTranslation();
  const resource = useApiResource<{ apps: InstalledAppView[] }>("/apps", 5000);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const anchor = useRef<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    start: Point;
    bounds: Map<string, Rect>;
    initial: ReadonlySet<string>;
    additive: boolean;
    toggle: boolean;
  } | null>(null);
  const apps = (resource.data?.apps ?? [])
    .filter((app) =>
      localized(app.name, i18n.language)
        .toLocaleLowerCase(i18n.language)
        .includes(query.toLocaleLowerCase(i18n.language)),
    )
    .sort((a, b) =>
      localized(a.name, i18n.language).localeCompare(
        localized(b.name, i18n.language),
        i18n.language,
      ),
    );
  const selection = apps.filter((app) => selected.has(app.id));
  const details = resource.data?.apps.find((app) => app.id === detailsId);
  const open = (app: InstalledAppView) => {
    const link = appLaunchLinks(app, window.location.hostname)[0];
    if (link) window.open(link.href, "_blank", "noopener,noreferrer");
    else setDetailsId(app.id);
  };
  const onJob = (job: AppJobView) => {
    setJobId(job.id);
    setDismissed(false);
    resource.reload();
  };
  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      event.pointerType === "touch" ||
      !(event.target instanceof Element) ||
      !event.currentTarget.contains(event.target) ||
      event.target.closest("button, input, a")
    )
      return;
    const element = event.currentTarget;
    const box = element.getBoundingClientRect();
    if (
      event.clientX >= box.left + element.clientWidth ||
      event.clientY >= box.top + element.clientHeight
    )
      return;
    event.preventDefault();
    element.focus();
    const bounds = new Map<string, Rect>();
    element.querySelectorAll<HTMLElement>("[data-installed-app]").forEach((item) => {
      const rect = item.getBoundingClientRect();
      bounds.set(item.dataset.installedApp!, {
        x: rect.x - box.x + element.scrollLeft,
        y: rect.y - box.y + element.scrollTop,
        width: rect.width,
        height: rect.height,
      });
    });
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    drag.current = {
      pointerId: event.pointerId,
      start: {
        x: event.clientX - box.x + element.scrollLeft,
        y: event.clientY - box.y + element.scrollTop,
      },
      bounds,
      initial: selected,
      additive,
      toggle: event.ctrlKey || event.metaKey,
    };
    if (!additive) setSelected(new Set());
    element.setPointerCapture(event.pointerId);
  };
  const extend = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const element = event.currentTarget;
    const box = element.getBoundingClientRect();
    const rect = selectionRect(current.start, {
      x: Math.max(0, Math.min(element.clientWidth, event.clientX - box.x)) + element.scrollLeft,
      y: Math.max(0, Math.min(element.clientHeight, event.clientY - box.y)) + element.scrollTop,
    });
    const next = new Set(current.additive ? current.initial : []);
    for (const id of iconsInRect(rect, current.bounds)) {
      if (current.toggle && next.has(id)) next.delete(id);
      else next.add(id);
    }
    setSelected(next);
    setMarquee(rect);
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (event.type === "pointercancel" || event.type === "lostpointercapture")
      setSelected(current.initial);
    drag.current = null;
    setMarquee(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <section className="flex h-full min-h-0 flex-col" data-testid="applications-folder">
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
        <div className="min-w-0 flex-1">
          <Field
            label={t("appStore.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={selection.length !== 1}
          onClick={() => setDetailsId(selection[0]!.id)}
        >
          <Info className="size-4" aria-hidden />
          {t("applications.details")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={resource.reload}
          aria-label={t("common.refresh")}
        >
          <RefreshCw className="size-4" aria-hidden />
        </Button>
      </div>
      <div className="px-3 pt-3">
        <ResourceError error={resource.error} />
        {jobId ? (
          <Progress
            key={jobId}
            id={jobId}
            onChanged={resource.reload}
            dismissed={dismissed}
            onDismiss={() => setDismissed(true)}
          />
        ) : null}
      </div>
      <div
        ref={grid}
        className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        tabIndex={0}
        aria-label={t("apps.applications")}
        data-testid="applications-grid"
        onPointerDown={begin}
        onPointerMove={extend}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            setSelected(new Set(apps.map((app) => app.id)));
          } else if (event.key === "Escape") {
            setSelected(new Set());
          } else if (
            event.key === "Enter" &&
            event.target === event.currentTarget &&
            selection.length === 1
          ) {
            event.preventDefault();
            open(selection[0]!);
          }
        }}
      >
        {resource.loading ? (
          <LoadingBlock />
        ) : !apps.length ? (
          <p className="p-8 text-center text-sm text-fg-muted">
            {t(resource.data?.apps.length ? "appStore.noResults" : "applications.empty")}
          </p>
        ) : (
          <div
            role="listbox"
            aria-label={t("apps.applications")}
            aria-multiselectable="true"
            data-icon-grid
            className="grid grid-cols-[repeat(auto-fill,minmax(116px,1fr))] content-start gap-2 p-3"
          >
            {apps.map((app) => {
              const name = localized(app.name, i18n.language);
              return (
                <button
                  key={app.id}
                  type="button"
                  role="option"
                  aria-label={name}
                  aria-selected={selected.has(app.id)}
                  data-installed-app={app.id}
                  className={cn(
                    "relative flex select-none flex-col items-center gap-1.5 rounded-lg p-2 outline-none hover:z-20 hover:bg-hover/5 focus-visible:ring-2 focus-visible:ring-accent",
                    selected.has(app.id) && "z-10",
                  )}
                  onClick={(event) => {
                    setSelected(
                      selectIcon(
                        selected,
                        app.id,
                        apps.map((entry) => entry.id),
                        anchor.current,
                        event,
                      ),
                    );
                    if (!event.shiftKey) anchor.current = app.id;
                  }}
                  onDoubleClick={() => open(app)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      open(app);
                    }
                  }}
                >
                  <span
                    className={cn(
                      "grid size-[68px] place-items-center rounded-xl",
                      selected.has(app.id) && "bg-hover/15 ring-1 ring-accent/30",
                    )}
                  >
                    <InstalledAppIcon app={app} />
                  </span>
                  <IconLabel text={name} />
                  <span className="text-[0.65rem] text-fg-muted">
                    {t(`appStore.states.${app.state}`)}
                  </span>
                  <SimulatedBadge source={app.source} />
                </button>
              );
            })}
          </div>
        )}
        {marquee ? (
          <div
            aria-hidden
            className="pointer-events-none absolute z-30 border border-accent/80 bg-accent/15"
            style={{
              left: marquee.x,
              top: marquee.y,
              width: marquee.width,
              height: marquee.height,
            }}
          />
        ) : null}
      </div>
      <footer className="border-t border-line px-3 py-2 text-xs text-fg-muted" role="status">
        {t("applications.count", { count: apps.length })}
        {selection.length ? " · " + t("files.selectedCount", { count: selection.length }) : ""}
      </footer>
      {details ? (
        <Dialog
          open
          onOpenChange={(value) => !value && setDetailsId(null)}
          title={localized(details.name, i18n.language)}
        >
          <InstalledCard key={details.id} app={details} onJob={onJob} onChanged={resource.reload} />
        </Dialog>
      ) : null}
    </section>
  );
}
