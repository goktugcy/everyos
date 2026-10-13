import { ArrowLeft, ArrowRight, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.tsx";
import { usePermissions } from "../../stores/session-store.ts";
import { DEFAULT_MENUBAR } from "../state/defaults.ts";
import { updatePreference, usePreferences } from "../state/preferences-store.ts";
import { Toggle } from "./quick-settings.tsx";
import { moduleOrder, moduleVisibility, moveModule } from "./module-order.ts";

/** The same per-user controls are available from Settings and the bar's context menu. */
export function MenubarCustomization() {
  const { t } = useTranslation();
  const preferences = usePreferences((state) => state.menubar);
  const enabled = usePermissions().includes("preferences:manage");
  const order = moduleOrder(preferences.order);
  return (
    <div className="flex flex-col gap-3" data-testid="menubar-customization">
      <p className="text-xs text-fg-muted">{t("menubar.customizeHint")}</p>
      <ul className="flex flex-col gap-1">
        {order.map((id, index) => {
          const name = t(`settings.desktop.menubarModules.${id}`);
          return (
            <li
              key={id}
              data-menubar-control={id}
              className="flex items-center gap-2 rounded-md px-1 py-1"
            >
              <span className="min-w-0 flex-1 text-sm">{name}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!enabled || index === 0}
                aria-label={t("menubar.moveLeft", { name })}
                onClick={() => updatePreference("menubar", (doc) => moveModule(doc, id, -1))}
              >
                <ArrowLeft className="size-4" aria-hidden />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!enabled || index === order.length - 1}
                aria-label={t("menubar.moveRight", { name })}
                onClick={() => updatePreference("menubar", (doc) => moveModule(doc, id, 1))}
              >
                <ArrowRight className="size-4" aria-hidden />
              </Button>
              <Toggle
                label={name}
                disabled={!enabled}
                checked={!preferences.hidden.includes(id)}
                onCheckedChange={(visible) =>
                  updatePreference("menubar", (doc) => moduleVisibility(doc, id, visible))
                }
              />
            </li>
          );
        })}
      </ul>
      <label className="flex items-center justify-between gap-3 border-t border-line pt-3 text-sm">
        <span>{t("settings.desktop.clockSeconds")}</span>
        <Toggle
          label={t("settings.desktop.clockSeconds")}
          disabled={!enabled}
          checked={preferences.clockSeconds}
          onCheckedChange={(clockSeconds) =>
            updatePreference("menubar", (doc) => ({ ...doc, clockSeconds }))
          }
        />
      </label>
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        disabled={!enabled}
        onClick={() => updatePreference("menubar", () => DEFAULT_MENUBAR)}
      >
        <RotateCcw className="size-4" aria-hidden />
        {t("menubar.reset")}
      </Button>
    </div>
  );
}
