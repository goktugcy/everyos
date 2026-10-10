import type { DesktopItem } from "@otuken/shared";
import { workArea } from "@otuken/window-manager";
import { AppWindow, FolderOutput } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { MenuEntry } from "../../menus/menu-model.ts";
import { ContextMenuArea } from "../../menus/menus.tsx";
import { desktop } from "../../state/controller.ts";
import { moveOutOfFolder } from "../../state/desktop-ops.ts";
import { updatePreference, usePreferences } from "../../state/preferences-store.ts";
import { wm } from "../../state/window-store.ts";
import { gridMetrics } from "../../surface/icon-grid.ts";
import { useThemeStore } from "../../theme/theme-store.ts";
import { useAppHost } from "../app-context.ts";
import { AppIcon } from "../app-icon.tsx";
import { getApp } from "../registry.ts";
import type { AppId } from "../types.ts";

/** Contents of a desktop folder. */
export default function FolderApp() {
  const { t } = useTranslation();
  const host = useAppHost();
  const folderId = (host.appState as { folderId?: string } | undefined)?.folderId;
  const items = usePreferences((state) => state.desktop.items);
  const iconSize = useThemeStore((state) => state.theme.iconSize);
  const folder = items.find((item) => item.id === folderId && item.kind === "folder");
  const children = items.filter(
    (item): item is Extract<DesktopItem, { kind: "app" }> =>
      item.kind === "app" && item.folderId === folderId,
  );

  useEffect(() => {
    if (folder?.kind === "folder") host.setTitle(folder.name);
  }, [folder, host]);

  if (!folder) {
    return <p className="p-6 text-sm text-fg-muted">{t("errors.NOT_FOUND")}</p>;
  }
  if (children.length === 0) {
    return <p className="p-6 text-sm leading-relaxed text-fg-muted">{t("desktop.emptyFolder")}</p>;
  }

  const metrics = () => gridMetrics(iconSize, workArea(wm().viewport));
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2 overflow-y-auto p-4">
      {children.map((item) => {
        const manifest = getApp(item.appId);
        if (!manifest) return null;
        const menu = (): MenuEntry[] => [
          {
            kind: "item",
            id: "open",
            label: t("desktop.menu.open"),
            icon: <AppWindow />,
            onSelect: () => desktop.openApp(item.appId as AppId),
          },
          {
            kind: "item",
            id: "out",
            label: t("desktop.menu.moveOutOfFolder"),
            icon: <FolderOutput />,
            onSelect: () =>
              updatePreference("desktop", (doc) => moveOutOfFolder(doc, item.id, metrics())),
          },
        ];
        return (
          <li key={item.id}>
            <ContextMenuArea entries={menu}>
              <button
                type="button"
                onDoubleClick={() => desktop.openApp(item.appId as AppId)}
                onKeyDown={(event) => event.key === "Enter" && desktop.openApp(item.appId as AppId)}
                className="flex w-full flex-col items-center gap-1.5 rounded-otk-md p-2 outline-none hover:bg-hover/8 focus-visible:ring-2 focus-visible:ring-accent"
              >
                <AppIcon manifest={manifest} size={44} />
                <span className="line-clamp-2 text-center text-xs">{t(manifest.titleKey)}</span>
              </button>
            </ContextMenuArea>
          </li>
        );
      })}
    </ul>
  );
}
