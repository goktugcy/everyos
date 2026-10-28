import { RENDER_MODES, THEME_PRESET_IDS } from "@everyos/shared";
import { THEME_PRESETS } from "@everyos/theme";
import { Check, Lock, SlidersHorizontal, Palette } from "lucide-react";
import { Popover, Switch, ToggleGroup } from "radix-ui";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { desktop } from "../state/controller.ts";
import { updatePreference, usePreferences } from "../state/preferences-store.ts";
import { menubarButton } from "./menubar-button.ts";

export function ThemeSwatch({
  id,
  selected,
}: {
  id: (typeof THEME_PRESET_IDS)[number];
  selected: boolean;
}) {
  const palette = THEME_PRESETS[id].palette;
  return (
    <span
      aria-hidden
      className={cn(
        "relative grid size-9 place-items-center rounded-full border",
        selected ? "border-accent ring-2 ring-accent" : "border-line",
      )}
      style={{
        background: `linear-gradient(135deg, ${palette.surface} 45%, ${palette.accent} 46%, ${palette.accentStrong})`,
      }}
    >
      {selected ? <Check className="size-4" style={{ color: palette.text }} /> : null}
    </span>
  );
}

export function QuickSettings() {
  const pulseEnabled = usePreferences((state) => state.pulse.enabled);
  const { t } = useTranslation();
  const appearance = usePreferences((state) => state.appearance);
  const lock = useSessionStore((state) => state.lock);

  return (
    <Popover.Root>
      <Popover.Trigger className={menubarButton} aria-label={t("menubar.quickSettings")}>
        <SlidersHorizontal className="size-4" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className="glass-strong everyos-enter z-[8000] flex w-80 flex-col gap-4 rounded-everyos-lg p-4 text-sm text-fg"
          aria-label={t("menubar.quickSettings")}
          onCloseAutoFocus={(event) => {
            const active = document.activeElement;
            // A deferred close must not steal focus from an app selected in the meantime.
            if (
              active &&
              active !== document.body &&
              event.target instanceof HTMLElement &&
              !event.target.contains(active)
            )
              event.preventDefault();
          }}
        >
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              {t("quickSettings.theme")}
            </h3>
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-label={t("quickSettings.theme")}
            >
              {THEME_PRESET_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={appearance.themeId === id}
                  aria-label={t(`themes.${id}`)}
                  title={t(`themes.${id}`)}
                  className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  onClick={() =>
                    updatePreference("appearance", (current) => ({
                      ...current,
                      themeId: id,
                      accent: null,
                    }))
                  }
                >
                  <ThemeSwatch id={id} selected={appearance.themeId === id} />
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              {t("quickSettings.renderMode")}
            </h3>
            <ToggleGroup.Root
              type="single"
              value={appearance.renderMode}
              onValueChange={(value) =>
                value &&
                updatePreference("appearance", (current) => ({
                  ...current,
                  renderMode: value as typeof current.renderMode,
                }))
              }
              className="glass-inset grid grid-cols-3 gap-1 rounded-everyos-md p-1"
              aria-label={t("quickSettings.renderMode")}
            >
              {RENDER_MODES.map((mode) => (
                <ToggleGroup.Item
                  key={mode}
                  value={mode}
                  className="rounded-[calc(var(--everyos-radius-md)-4px)] px-2 py-1.5 text-xs font-medium text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent data-[state=on]:bg-[rgb(var(--everyos-accent)/0.22)] data-[state=on]:text-fg"
                >
                  {t(`renderModes.${mode}`)}
                </ToggleGroup.Item>
              ))}
            </ToggleGroup.Root>
            <p className="text-xs leading-relaxed text-fg-subtle">
              {t(`renderModeHints.${appearance.renderMode}`)}
            </p>
          </section>

          <label className="flex items-center justify-between gap-3">
            <span>{t("quickSettings.animatedWallpaper")}</span>
            <Toggle
              checked={appearance.wallpaperAnimated}
              disabled={appearance.renderMode === "performance"}
              onCheckedChange={(checked) =>
                updatePreference("appearance", (current) => ({
                  ...current,
                  wallpaperAnimated: checked,
                }))
              }
            />
          </label>

          <label className="flex items-center justify-between gap-3">
            <span>{t("quickSettings.pulse")}</span>
            <Toggle
              checked={pulseEnabled}
              onCheckedChange={(enabled) =>
                updatePreference("pulse", (current) => ({ ...current, enabled }))
              }
            />
          </label>

          <div className="flex gap-2 border-t border-line pt-3">
            <Popover.Close asChild>
              <button
                type="button"
                className="flex flex-1 items-center gap-2 rounded-everyos-md px-3 py-2 text-left hover:bg-hover/10"
                onClick={() => desktop.openSettings("appearance")}
              >
                <Palette className="size-4 text-fg-subtle" aria-hidden />
                <span className="truncate">{t("quickSettings.appearanceSettings")}</span>
              </button>
            </Popover.Close>
            <Popover.Close asChild>
              <button
                type="button"
                className="flex items-center gap-2 rounded-everyos-md px-3 py-2 hover:bg-hover/10"
                onClick={() => void lock()}
              >
                <Lock className="size-4 text-fg-subtle" aria-hidden />
                {t("quickSettings.lock")}
              </button>
            </Popover.Close>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Radix switch styled for the glass UI. */
export function Toggle({
  checked,
  onCheckedChange,
  disabled,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled === true}
      aria-label={label}
      className="relative h-6 w-10 shrink-0 rounded-full bg-hover/20 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 data-[state=checked]:bg-[rgb(var(--everyos-accent))]"
    >
      <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </Switch.Root>
  );
}
