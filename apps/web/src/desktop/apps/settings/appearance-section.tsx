import {
  ICON_SIZES,
  RENDER_MODES,
  THEME_PRESET_IDS,
  WINDOW_ANIMATIONS,
  type CustomTheme,
  type ThemeEffects,
} from "@otuken/shared";
import {
  DEFAULT_APPEARANCE,
  exportTheme,
  importTheme,
  requestedEffects,
  THEME_PRESETS,
} from "@otuken/theme";
import { Download, FileUp, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { Slider } from "../../../components/ui/slider.tsx";
import { cn } from "../../../lib/cn.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { Toggle } from "../../menubar/quick-settings.tsx";
import { newId } from "../../state/ids.ts";
import {
  resetPreference,
  updatePreference,
  usePreferences,
} from "../../state/preferences-store.ts";
import { useThemeStore } from "../../theme/theme-store.ts";
import { WallpaperView } from "../../wallpaper/wallpaper-view.tsx";
import { SettingRow, SettingsGroup } from "./group.tsx";
import { FolderIconPicker } from "./folder-icon-picker.tsx";
import { WallpaperPicker } from "./wallpaper-picker.tsx";

function ThemeCard({
  id,
  selected,
  onSelect,
}: {
  id: (typeof THEME_PRESET_IDS)[number];
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const preset = THEME_PRESETS[id];
  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        data-theme-option={id}
        className={cn(
          "group flex w-full flex-col gap-2 rounded-otk-md p-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent",
          selected ? "bg-[rgb(var(--otk-accent)/0.18)]" : "hover:bg-hover/8",
        )}
      >
        <span
          className={cn(
            "relative block aspect-[16/10] overflow-hidden rounded-otk-sm border",
            selected ? "border-accent" : "border-line",
          )}
        >
          <WallpaperView spec={{ kind: "preset", id: preset.wallpaper }} />
          <span
            className="absolute inset-x-[14%] bottom-[16%] top-[22%] rounded-md border"
            style={{
              background: `${preset.palette.surface}${Math.round(
                preset.effects.surfaceOpacity * 255,
              )
                .toString(16)
                .padStart(2, "0")}`,
              borderColor: `${preset.palette.border}33`,
            }}
          >
            <span
              className="absolute left-[10%] top-[18%] h-[12%] w-[46%] rounded-sm"
              style={{ background: preset.palette.text, opacity: 0.85 }}
            />
            <span
              className="absolute left-[10%] top-[42%] h-[10%] w-[64%] rounded-sm"
              style={{ background: preset.palette.textMuted, opacity: 0.6 }}
            />
            <span
              className="absolute bottom-[14%] right-[10%] h-[20%] w-[30%] rounded-sm"
              style={{
                background: `linear-gradient(135deg, ${preset.palette.accent}, ${preset.palette.accentStrong})`,
              }}
            />
          </span>
        </span>
        <span className="px-0.5 text-xs font-medium">{t(`themes.${id}`)}</span>
      </button>
    </li>
  );
}

export default function AppearanceSection() {
  const { t } = useTranslation();
  const appearance = usePreferences((state) => state.appearance);
  const theme = useThemeStore((state) => state.theme);
  const [customName, setCustomName] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const setEffect = (key: keyof ThemeEffects, value: number) =>
    updatePreference("appearance", (current) => ({
      ...current,
      effects: { ...current.effects, [key]: value },
    }));

  const saveCustom = () => {
    const id = newId("t");
    const base = theme.id.startsWith("custom:")
      ? (appearance.customThemes.find((c) => `custom:${c.id}` === theme.id)?.base ?? "liquid-dark")
      : (theme.id as CustomTheme["base"]);
    const custom: CustomTheme = {
      id,
      name: customName.trim() || t("settings.appearance.defaultCustomName"),
      base,
      accent: theme.palette.accent,
      effects: { ...appearance.effects },
      wallpaper: appearance.wallpaper,
    };
    updatePreference("appearance", (current) => ({
      ...current,
      themeId: `custom:${id}`,
      accent: null,
      effects: {},
      customThemes: [...current.customThemes, custom].slice(-20),
    }));
    setCustomName("");
  };

  const downloadTheme = (custom: CustomTheme) => {
    const blob = new Blob([exportTheme(custom)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `otuken-theme-${custom.name.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase() || "custom"}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const importFile = async (file: File) => {
    const result = importTheme(await file.text(), newId("t"));
    if (!result.ok) {
      setNotice({ tone: "danger", text: t(`settings.appearance.importErrors.${result.error}`) });
      return;
    }
    updatePreference("appearance", (current) => ({
      ...current,
      customThemes: [...current.customThemes, result.theme].slice(-20),
    }));
    setNotice({ tone: "success", text: t("settings.appearance.imported") });
  };

  const requested = requestedEffects(appearance);
  const percent = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title={t("settings.appearance.theme")}>
        <ul
          role="radiogroup"
          aria-label={t("settings.appearance.theme")}
          className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2"
        >
          {THEME_PRESET_IDS.map((id) => (
            <ThemeCard
              key={id}
              id={id}
              selected={appearance.themeId === id}
              onSelect={() =>
                updatePreference("appearance", (a) => ({ ...a, themeId: id, accent: null }))
              }
            />
          ))}
        </ul>
      </SettingsGroup>

      <SettingsGroup title={t("folderIcons.title")} description={t("folderIcons.defaultHint")}>
        <FolderIconPicker
          value={appearance.folderIcon ?? { kind: "preset", id: "classic" }}
          onChange={(folderIcon) =>
            updatePreference("appearance", (current) => ({ ...current, folderIcon }))
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.appearance.customThemes")}>
        {appearance.customThemes.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("settings.appearance.noCustomThemes")}</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {appearance.customThemes.map((custom) => {
            const selected = appearance.themeId === `custom:${custom.id}`;
            return (
              <li
                key={custom.id}
                className={cn(
                  "flex items-center gap-3 rounded-otk-md p-2",
                  selected && "bg-[rgb(var(--otk-accent)/0.15)]",
                )}
              >
                <span
                  aria-hidden
                  className="size-7 shrink-0 rounded-full border border-line"
                  style={{
                    background: `linear-gradient(135deg, ${THEME_PRESETS[custom.base].palette.surface} 45%, ${custom.accent} 46%)`,
                  }}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-sm font-medium"
                  onClick={() =>
                    updatePreference("appearance", (a) => ({
                      ...a,
                      themeId: `custom:${custom.id}`,
                      accent: null,
                    }))
                  }
                  aria-pressed={selected}
                >
                  {custom.name}
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${t("settings.appearance.exportTheme")}: ${custom.name}`}
                  onClick={() => downloadTheme(custom)}
                >
                  <Download className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${t("settings.appearance.deleteTheme")}: ${custom.name}`}
                  onClick={() =>
                    updatePreference("appearance", (a) => ({
                      ...a,
                      themeId: a.themeId === `custom:${custom.id}` ? custom.base : a.themeId,
                      customThemes: a.customThemes.filter((c) => c.id !== custom.id),
                    }))
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <Field
              label={t("settings.appearance.customName")}
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder={t("settings.appearance.defaultCustomName")}
              maxLength={40}
            />
          </div>
          <Button variant="secondary" onClick={saveCustom}>
            {t("settings.appearance.saveAsCustom")}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importFile(file);
            }}
          />
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>
            <FileUp className="size-4" aria-hidden />
            {t("settings.appearance.importTheme")}
          </Button>
        </div>
        {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      </SettingsGroup>

      <SettingsGroup title={t("settings.appearance.accent")}>
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={theme.palette.accent}
            onChange={(event) =>
              updatePreference("appearance", (a) => ({ ...a, accent: event.target.value }))
            }
            aria-label={t("settings.appearance.accent")}
            className="h-10 w-16 cursor-pointer rounded-otk-sm border border-line bg-transparent"
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={appearance.accent === null}
            onClick={() => updatePreference("appearance", (a) => ({ ...a, accent: null }))}
          >
            {t("settings.appearance.accentDefault")}
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.appearance.wallpaper")}>
        <WallpaperPicker />
        <SettingRow label={t("settings.appearance.animatedWallpaper")}>
          <Toggle
            label={t("settings.appearance.animatedWallpaper")}
            checked={appearance.wallpaperAnimated}
            disabled={appearance.renderMode === "performance"}
            onCheckedChange={(checked) =>
              updatePreference("appearance", (a) => ({ ...a, wallpaperAnimated: checked }))
            }
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.appearance.effects")}>
        <Slider
          label={t("settings.appearance.surfaceOpacity")}
          value={requested.surfaceOpacity}
          min={0.3}
          max={1}
          step={0.01}
          onChange={(v) => setEffect("surfaceOpacity", v)}
          format={percent}
          {...(theme.minReadableOpacity > requested.surfaceOpacity
            ? {
                hint: t("settings.appearance.readability", {
                  value: Math.round(theme.minReadableOpacity * 100),
                }),
              }
            : {})}
        />
        <Slider
          label={t("settings.appearance.blur")}
          value={requested.blur}
          min={0}
          max={40}
          step={1}
          onChange={(v) => setEffect("blur", v)}
          format={(v) => `${v}px`}
        />
        <Slider
          label={t("settings.appearance.border")}
          value={requested.borderIntensity}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => setEffect("borderIntensity", v)}
          format={percent}
        />
        <Slider
          label={t("settings.appearance.shadow")}
          value={requested.shadowIntensity}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => setEffect("shadowIntensity", v)}
          format={percent}
        />
        <Slider
          label={t("settings.appearance.radius")}
          value={requested.radius}
          min={4}
          max={32}
          step={1}
          onChange={(v) => setEffect("radius", v)}
          format={(v) => `${v}px`}
        />
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.appearance.renderMode")}
        description={t(`renderModeHints.${appearance.renderMode}`)}
      >
        <Select
          label={t("settings.appearance.renderMode")}
          hideLabel
          value={appearance.renderMode}
          options={RENDER_MODES.map((mode) => ({ value: mode, label: t(`renderModes.${mode}`) }))}
          onChange={(renderMode) => updatePreference("appearance", (a) => ({ ...a, renderMode }))}
        />
        <Select
          label={t("settings.appearance.windowAnimation")}
          value={appearance.windowAnimation}
          options={WINDOW_ANIMATIONS.map((value) => ({
            value,
            label: t(`settings.appearance.windowAnimations.${value}`),
          }))}
          onChange={(windowAnimation) =>
            updatePreference("appearance", (a) => ({ ...a, windowAnimation }))
          }
        />
        <Slider
          label={t("settings.appearance.fontScale")}
          value={appearance.fontScale}
          min={0.85}
          max={1.3}
          step={0.05}
          onChange={(fontScale) => updatePreference("appearance", (a) => ({ ...a, fontScale }))}
          format={percent}
        />
        <Select
          label={t("settings.appearance.iconSize")}
          value={appearance.iconSize}
          options={ICON_SIZES.map((value) => ({
            value,
            label: t(`settings.appearance.iconSizes.${value}`),
          }))}
          onChange={(iconSize) => updatePreference("appearance", (a) => ({ ...a, iconSize }))}
        />
      </SettingsGroup>

      <div className="flex justify-end">
        <Button
          variant="ghost"
          onClick={() =>
            void requestConfirm({
              title: t("settings.appearance.resetAll"),
              body: t("settings.appearance.resetAll"),
              confirmLabel: t("common.reset"),
              danger: false,
            }).then(
              (ok) =>
                ok &&
                resetPreference("appearance", {
                  ...DEFAULT_APPEARANCE,
                  customThemes: appearance.customThemes,
                }),
            )
          }
        >
          {t("settings.appearance.resetAll")}
        </Button>
      </div>
    </div>
  );
}
