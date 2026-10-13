import { DOCK_POSITIONS, DOCK_STYLES, MAX_DESKTOPS } from "@everyos/shared";
import { workArea } from "@everyos/window-manager";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { Slider } from "../../../components/ui/slider.tsx";
import { inputClassName } from "../../../components/ui/field.tsx";
import { usePermissions } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { formatShortcut } from "../../menus/menu-model.ts";
import { Toggle } from "../../menubar/quick-settings.tsx";
import { MenubarCustomization } from "../../menubar/customization.tsx";
import { DEFAULT_MENUBAR, defaultDesktop, defaultDock } from "../../state/defaults.ts";
import { addDesktop, removeDesktop, renameDesktop } from "../../state/desktop-ops.ts";
import { updatePreference, usePreferences } from "../../state/preferences-store.ts";
import { useWindowManager, wm } from "../../state/window-store.ts";
import { gridMetrics } from "../../surface/icon-grid.ts";
import { useThemeStore } from "../../theme/theme-store.ts";
import { SettingRow, SettingsGroup } from "./group.tsx";

const SHORTCUTS = [
  ["launcher", "Ctrl+K · Alt+Space"],
  ["close", "Ctrl+Alt+W"],
  ["minimize", "Ctrl+Alt+↓"],
  ["maximize", "Ctrl+Alt+↑"],
  ["snapLeft", "Ctrl+Alt+←"],
  ["snapRight", "Ctrl+Alt+→"],
  ["cycle", "Alt+`"],
  ["desktops", "Ctrl+Alt+PageUp / PageDown"],
  ["tile", "Ctrl+Alt+T"],
  ["lock", "Ctrl+Alt+L"],
] as const;

export default function DesktopSection() {
  const { t } = useTranslation();
  const desktops = usePreferences((state) => state.desktop.desktops);
  const dock = usePreferences((state) => state.dock);
  const pulse = usePreferences((state) => state.pulse);
  const permissions = usePermissions();
  const iconSize = useThemeStore((state) => state.theme.iconSize);
  const viewport = useWindowManager((state) => state.viewport);

  const remove = async (id: string, name: string) => {
    const ok = await requestConfirm({
      title: `${t("settings.desktop.removeDesktop")}: ${name}`,
      body: t("settings.desktop.removeDesktopHint"),
      confirmLabel: t("settings.desktop.removeDesktop"),
    });
    if (!ok) return;
    const target = desktops.find((d) => d.id !== id);
    if (!target) return;
    wm().mergeDesktop(id, target.id);
    updatePreference("desktop", (doc) =>
      removeDesktop(doc, id, gridMetrics(iconSize, workArea(viewport))),
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title={t("settings.desktop.desktops")}>
        <ul className="flex flex-col gap-2">
          {desktops.map((entry, index) => (
            <li key={entry.id} className="flex items-center gap-2">
              <span className="w-6 text-center text-sm text-fg-subtle">{index + 1}</span>
              <input
                defaultValue={entry.name}
                aria-label={t("settings.desktop.desktopName")}
                maxLength={32}
                className={inputClassName + " h-10"}
                onBlur={(event) =>
                  updatePreference("desktop", (doc) =>
                    renameDesktop(doc, entry.id, event.currentTarget.value),
                  )
                }
                onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${t("settings.desktop.removeDesktop")}: ${entry.name}`}
                disabled={desktops.length <= 1}
                onClick={() => void remove(entry.id, entry.name)}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={desktops.length >= MAX_DESKTOPS}
            onClick={() =>
              updatePreference(
                "desktop",
                (doc) =>
                  addDesktop(doc, t("desktop.defaultName", { n: doc.desktops.length + 1 })).doc,
              )
            }
          >
            <Plus className="size-4" aria-hidden />
            {t("settings.desktop.addDesktop")}
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.desktop.dock")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label={t("settings.desktop.dockStyle")}
            value={dock.style}
            options={DOCK_STYLES.map((style) => ({
              value: style,
              label: t(`settings.desktop.dockStyles.${style}`),
            }))}
            onChange={(style) => updatePreference("dock", (d) => ({ ...d, style }))}
          />
          <Select
            label={t("settings.desktop.dockPosition")}
            value={dock.position}
            options={DOCK_POSITIONS.map((position) => ({
              value: position,
              label: t(`settings.desktop.dockPositions.${position}`),
            }))}
            onChange={(position) => updatePreference("dock", (d) => ({ ...d, position }))}
          />
        </div>
        <Slider
          label={t("settings.desktop.dockIconSize")}
          value={dock.iconSize}
          min={32}
          max={72}
          step={2}
          onChange={(iconSize) => updatePreference("dock", (d) => ({ ...d, iconSize }))}
          format={(v) => `${v}px`}
        />
        <Slider
          label={t("settings.desktop.dockOpacity")}
          value={dock.opacity}
          min={0.3}
          max={1}
          step={0.05}
          onChange={(opacity) => updatePreference("dock", (d) => ({ ...d, opacity }))}
          format={(v) => `${Math.round(v * 100)}%`}
        />
        <SettingRow label={t("settings.desktop.magnification")}>
          <Toggle
            label={t("settings.desktop.magnification")}
            checked={dock.magnification}
            onCheckedChange={(magnification) =>
              updatePreference("dock", (d) => ({ ...d, magnification }))
            }
          />
        </SettingRow>
        <SettingRow label={t("settings.desktop.autoHide")}>
          <Toggle
            label={t("settings.desktop.autoHide")}
            checked={dock.autoHide}
            onCheckedChange={(autoHide) => updatePreference("dock", (d) => ({ ...d, autoHide }))}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.desktop.menubar")}>
        <MenubarCustomization />
      </SettingsGroup>

      <SettingsGroup title={t("settings.desktop.pulse")}>
        <p className="text-xs text-fg-muted">{t("settings.desktop.pulseHint")}</p>
        <SettingRow label={t("settings.desktop.pulseEnabled")}>
          <Toggle
            label={t("settings.desktop.pulseEnabled")}
            checked={pulse.enabled}
            onCheckedChange={(enabled) => updatePreference("pulse", (n) => ({ ...n, enabled }))}
          />
        </SettingRow>
        <SettingRow label={t("settings.desktop.pulseHover")}>
          <Toggle
            label={t("settings.desktop.pulseHover")}
            checked={pulse.openOnHover}
            onCheckedChange={(openOnHover) =>
              updatePreference("pulse", (n) => ({ ...n, openOnHover }))
            }
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.desktop.shortcuts")}>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map(([id, keys]) => (
            <div key={id} className="contents">
              <dt className="text-fg-muted">{t(`settings.desktop.shortcutList.${id}`)}</dt>
              <dd>
                <kbd className="rounded-md bg-hover/10 px-2 py-0.5 font-sans text-xs">
                  {formatShortcut(keys)}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.desktop.resetLayout")}
        description={t("settings.desktop.resetLayoutHint")}
      >
        <div>
          <Button
            variant="secondary"
            onClick={() =>
              void requestConfirm({
                title: t("settings.desktop.resetLayout"),
                body: t("settings.desktop.resetLayoutHint"),
                confirmLabel: t("common.reset"),
              }).then((ok) => {
                if (!ok) return;
                const fresh = defaultDesktop(t, permissions);
                for (const window of Object.values(wm().windows))
                  wm().moveToDesktop(window.id, fresh.desktops[0]!.id);
                wm().switchDesktop(fresh.desktops[0]!.id);
                updatePreference("desktop", () => fresh);
                updatePreference("dock", () => defaultDock(permissions));
                updatePreference("menubar", () => DEFAULT_MENUBAR);
              })
            }
          >
            {t("settings.desktop.resetLayout")}
          </Button>
        </div>
      </SettingsGroup>
    </div>
  );
}
