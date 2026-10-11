import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_SEVERITIES,
  type NotificationSeverity,
} from "@everyos/shared";
import { useTranslation } from "react-i18next";
import { Select } from "../../../components/ui/select.tsx";
import { Toggle } from "../../menubar/quick-settings.tsx";
import { updatePreference, usePreferences } from "../../state/preferences-store.ts";
import { SettingRow, SettingsGroup } from "./group.tsx";

/** Per-user notification preferences (pop-ups and muted categories). */
export default function NotificationsSection() {
  const { t } = useTranslation();
  const preferences = usePreferences((state) => state.notifications);
  const update = (patch: Partial<typeof preferences>) =>
    updatePreference("notifications", (current) => ({ ...current, ...patch }));

  return (
    <>
      <SettingsGroup
        title={t("notifications.settingsTitle")}
        description={t("notifications.settingsHint")}
      >
        <SettingRow label={t("notifications.toasts")} hint={t("notifications.toastsHint")}>
          <Toggle
            label={t("notifications.toasts")}
            checked={preferences.toasts}
            onCheckedChange={(toasts) => update({ toasts })}
          />
        </SettingRow>
        <Select
          label={t("notifications.toastMinSeverity")}
          value={preferences.toastMinSeverity}
          options={NOTIFICATION_SEVERITIES.map((value) => ({
            value,
            label: t(`notifications.minSeverity.${value}`),
          }))}
          onChange={(value: NotificationSeverity) => update({ toastMinSeverity: value })}
        />
      </SettingsGroup>
      <SettingsGroup
        title={t("notifications.mutedTitle")}
        description={t("notifications.mutedHint")}
      >
        <ul className="grid gap-2 sm:grid-cols-2">
          {NOTIFICATION_CATEGORIES.map((category) => {
            const muted = preferences.mutedCategories.includes(category);
            return (
              <li key={category}>
                <label className="flex items-center justify-between gap-3 rounded-everyos-md px-2 py-1.5 text-sm hover:bg-hover/6">
                  <span>{t(`notifications.categories.${category}`)}</span>
                  <Toggle
                    label={t("notifications.notifyAbout", {
                      category: t(`notifications.categories.${category}`),
                    })}
                    checked={!muted}
                    onCheckedChange={(on) =>
                      update({
                        mutedCategories: on
                          ? preferences.mutedCategories.filter((c) => c !== category)
                          : [...preferences.mutedCategories, category],
                      })
                    }
                  />
                </label>
              </li>
            );
          })}
        </ul>
      </SettingsGroup>
    </>
  );
}
