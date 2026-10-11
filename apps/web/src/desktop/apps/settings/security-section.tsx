import { AUTO_LOCK_MINUTES, type AutoLockMinutes } from "@everyos/shared";
import { useTranslation } from "react-i18next";
import { Select } from "../../../components/ui/select.tsx";
import {
  PasswordSection,
  SessionsSection,
  TwoFactorSection,
} from "../../../features/account/account-security.tsx";
import { useSessionStore } from "../../../stores/session-store.ts";
import { updatePreference, usePreferences } from "../../state/preferences-store.ts";
import { SettingsGroup } from "./group.tsx";

export default function SecuritySection() {
  const { t } = useTranslation();
  const user = useSessionStore((state) => state.session?.user);
  const updateUser = useSessionStore((state) => state.updateUser);
  const autoLock = usePreferences((state) => state.security.autoLockMinutes);
  if (!user) return null;
  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title={t("account.totp.title")}>
        <TwoFactorSection user={user} onUserChange={updateUser} />
      </SettingsGroup>
      <SettingsGroup
        title={t("settings.security.autoLock")}
        description={t("settings.security.autoLockHint")}
      >
        <Select
          label={t("settings.security.autoLock")}
          hideLabel
          value={String(autoLock)}
          options={AUTO_LOCK_MINUTES.map((minutes) => ({
            value: String(minutes),
            label:
              minutes === 0
                ? t("settings.security.autoLockOff")
                : t("settings.security.autoLockAfter", { minutes }),
          }))}
          onChange={(value) =>
            updatePreference("security", (current) => ({
              ...current,
              autoLockMinutes: Number(value) as AutoLockMinutes,
            }))
          }
        />
      </SettingsGroup>
      <SettingsGroup title={t("account.password.title")}>
        <PasswordSection />
      </SettingsGroup>
      <SettingsGroup title={t("account.sessions.title")}>
        <SessionsSection />
      </SettingsGroup>
    </div>
  );
}
